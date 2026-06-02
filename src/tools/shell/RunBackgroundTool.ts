import * as path from "node:path";
import type { ApprovalManager } from "../../approval/ApprovalManager.js";
import { formatJobStart } from "./format.js";
import type { JobRegistry, JobStartResult } from "./JobRegistry.js";
import { isCommandAllowed } from "./parse.js";

export interface RunBackgroundToolOptions {
	jobs: JobRegistry;
	rootDir: string;
	extraAllowed?: readonly string[] | (() => readonly string[]);
	approvalManager?: ApprovalManager;
	onJobsChanged?: () => void;
}

export class RunBackgroundTool {
	name = "run_background";
	description =
		"Spawn a long-running process detached. Waits up to waitSec for startup or a ready signal. Returns job id. Use for dev servers / watchers / installs / large builds. No shell operators — single process only.";

	private readonly jobs: JobRegistry;
	private readonly rootDir: string;
	private readonly getExtraAllowed: () => readonly string[];
	private readonly approvalManager?: ApprovalManager;
	private readonly onJobsChanged?: () => void;

	constructor(options: RunBackgroundToolOptions) {
		this.jobs = options.jobs;
		this.rootDir = path.resolve(options.rootDir);
		this.approvalManager = options.approvalManager;
		this.onJobsChanged = options.onJobsChanged;
		this.getExtraAllowed =
			typeof options.extraAllowed === "function"
				? options.extraAllowed
				: (() => {
						const snap = options.extraAllowed ?? [];
						return () => snap;
					})();
	}

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					command: {
						type: "string",
						description: "Full command line — no shell operators.",
					},
					cwd: {
						type: "string",
						description:
							"Workspace-relative or absolute (must resolve inside rootDir).",
					},
					waitSec: {
						type: "integer",
						description: "Max startup wait. 0..30, default 3.",
					},
				},
				required: ["command"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { signal?: AbortSignal },
	): Promise<string> {
		const cmd = typeof args.command === "string" ? args.command.trim() : "";
		if (!cmd) return "Error: empty command";
		let cwd: string;
		try {
			cwd = this.resolveCwd(args.cwd);
		} catch (e: any) {
			return `Error: ${e.message}`;
		}
		const allowed = isCommandAllowed(cmd, this.getExtraAllowed(), this.rootDir);
		if (!allowed) {
			if (!this.approvalManager) {
				return `Error: command "${cmd}" is not allowlisted and no approval manager is configured.`;
			}
			const request = await this.approvalManager.requestApproval(
				this.name,
				{ command: cmd, cwd },
				`Spawn background: ${cmd}`,
			);
			const response = await this.approvalManager.checkApproval(request);
			if (!response.approved) {
				return `Error: command denied${response.reason ? ` — ${response.reason}` : ""}`;
			}
		}
		try {
			const result: JobStartResult = await this.jobs.start(cmd, {
				cwd,
				waitSec: args.waitSec,
				signal: context?.signal,
			});
			this.onJobsChanged?.();
			return formatJobStart(result);
		} catch (e: any) {
			return `Error: ${e.message}`;
		}
	}

	private resolveCwd(raw: unknown): string {
		if (!raw || typeof raw !== "string" || !raw.trim()) return this.rootDir;
		const resolved = path.resolve(this.rootDir, raw);
		const rel = path.relative(this.rootDir, resolved);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new Error(
				`cwd "${raw}" resolves outside rootDir ${this.rootDir}`,
			);
		}
		return resolved;
	}
}
