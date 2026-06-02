import { runCommand } from "./exec.js";
import { isCommandAllowed } from "./parse.js";
import { truncateToolResult } from "../truncateResult.js";
import type { ApprovalManager } from "../../approval/ApprovalManager.js";

export interface ExecShellToolOptions {
	rootDir?: string;
	timeoutSec?: number;
	maxOutputChars?: number;
	extraAllowed?: readonly string[] | (() => readonly string[]);
	approvalManager?: ApprovalManager;
}

/**
 * ExecShellTool — cross-platform shell command runner.
 *
 * Native argv tokenization (no `sh -c`): supports `|`, `&&`, `||`, `;`, `>`,
 * `>>`, `2>&1`, `&>` via the in-process chain parser. Allowlisted
 * read-only/test/lint commands run immediately; others gate on the
 * configured ApprovalManager (or reject when no manager is wired).
 */
export class ExecShellTool {
	name = "exec_shell";
	description =
		"Execute a shell command. Native arg-parsing supports `|` `&&` `||` `;` `>` `>>` `2>&1` cross-platform without invoking a real shell. Allowlisted commands (git status/diff/log, ls/cat/head/tail, npm test, vitest, tsc, biome, etc.) run immediately; non-allowlisted commands gate on the configured approval mode.";

	private readonly rootDir?: string;
	private readonly defaultTimeoutSec: number;
	private readonly maxOutputChars: number;
	private readonly getExtraAllowed: () => readonly string[];
	private readonly approvalManager?: ApprovalManager;

	constructor(options: ExecShellToolOptions = {}) {
		this.rootDir = options.rootDir;
		this.defaultTimeoutSec = options.timeoutSec ?? 60;
		this.maxOutputChars = options.maxOutputChars ?? 32_000;
		this.approvalManager = options.approvalManager;
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
					command: { type: "string", description: "Full command line." },
					timeoutSec: {
						type: "integer",
						description: `Per-command timeout in seconds (default ${this.defaultTimeoutSec}, max 600).`,
					},
					cwd: { type: "string", description: "Working directory override." },
				},
				required: ["command"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string; signal?: AbortSignal },
	): Promise<string> {
		const cmd = typeof args.command === "string" ? args.command.trim() : "";
		if (!cmd) return "Error: empty command";

		const cwd =
			(typeof args.cwd === "string" && args.cwd) ||
			context?.workingDirectory ||
			this.rootDir ||
			process.cwd();
		const timeoutSec = Math.max(1, Math.min(600, args.timeoutSec ?? this.defaultTimeoutSec));

		// Allowlist + approval gate
		const allowed = isCommandAllowed(cmd, this.getExtraAllowed(), cwd);
		if (!allowed) {
			if (!this.approvalManager) {
				return `Error: command "${cmd}" is not allowlisted and no approval manager is configured. Configure approvalMode or extraAllowed.`;
			}
			const request = await this.approvalManager.requestApproval(
				this.name,
				{ command: cmd },
				`Run shell command: ${cmd}`,
			);
			const response = await this.approvalManager.checkApproval(request);
			if (!response.approved) {
				return `Error: command denied${response.reason ? ` — ${response.reason}` : ""}`;
			}
		}

		const result = await runCommand(cmd, {
			cwd,
			timeoutSec,
			maxOutputChars: this.maxOutputChars,
			signal: context?.signal,
		});

		const header = result.timedOut
			? `$ ${cmd}\n[killed after timeout]`
			: `$ ${cmd}\n[exit ${result.exitCode ?? "?"}]`;
		const body = result.output ? `${header}\n${result.output}` : header;
		return truncateToolResult(body, undefined, "exec_shell");
	}
}
