import { runCommand } from "../exec.js";
import { classifyCommand } from "../policy/ShellClassifier.js";
import type { ShellCategory, ShellPolicyDecision } from "../policy/ShellTypes.js";
import { truncateToolResult } from "../../truncateResult.js";
import type { ApprovalManager } from "../../../approval/ApprovalManager.js";

export interface ShellCategoryToolOptions {
	name: string;
	description: string;
	allowedCategories: readonly ShellCategory[];

	rootDir?: string;
	timeoutSec?: number;
	maxOutputChars?: number;
	extraAllowed?: readonly string[];

	approvalManager?: ApprovalManager;
	rawEnabled?: boolean;
	sensitivePathMode?: "approval" | "deny";
}

export class ShellCategoryTool {
	name: string;
	description: string;

	private readonly opts: ShellCategoryToolOptions;
	private readonly defaultTimeoutSec: number;
	private readonly maxOutputChars: number;

	constructor(opts: ShellCategoryToolOptions) {
		this.opts = opts;
		this.name = opts.name;
		this.description = opts.description;
		this.defaultTimeoutSec = opts.timeoutSec ?? 60;
		this.maxOutputChars = opts.maxOutputChars ?? 32_000;
	}

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "Command line to run." },
					timeoutSec: {
						type: "integer",
						description: `Timeout in seconds (default ${this.defaultTimeoutSec}, max 600).`,
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
		const command = typeof args.command === "string" ? args.command.trim() : "";
		if (!command) return "Error: empty command";

		const cwd =
			(typeof args.cwd === "string" && args.cwd) ||
			context?.workingDirectory ||
			this.opts.rootDir ||
			process.cwd();

		const decision = classifyCommand(command, {
			cwd,
			allowedCategories: this.opts.allowedCategories,
			extraAllowed: this.opts.extraAllowed,
			rawEnabled: this.opts.rawEnabled,
			sensitivePathMode: this.opts.sensitivePathMode ?? "approval",
		});

		if (!decision.ok) {
			return this.renderDenied(decision);
		}

		const approvalResult = await this.checkApproval(command, decision);
		if (!approvalResult.approved) {
			return `Error: command denied${approvalResult.reason ? ` — ${approvalResult.reason}` : ""}`;
		}

		const timeoutSec = Math.max(
			1,
			Math.min(600, args.timeoutSec ?? this.defaultTimeoutSec),
		);

		const result = await runCommand(command, {
			cwd,
			timeoutSec,
			maxOutputChars: this.maxOutputChars,
			signal: context?.signal,
		});

		const header = result.timedOut
			? `$ ${command}\n[killed after timeout]`
			: `$ ${command}\n[exit ${result.exitCode ?? "?"}]`;
		const body = result.output ? `${header}\n${result.output}` : header;
		return truncateToolResult(body, undefined, this.name);
	}

	private async checkApproval(
		command: string,
		decision: ShellPolicyDecision,
	): Promise<{ approved: boolean; reason?: string }> {
		if (!this.opts.approvalManager) {
			if (decision.requiresApproval) {
				return { approved: false, reason: "approval manager is not configured" };
			}
			return { approved: true };
		}

		if (!decision.requiresApproval && decision.risk === "low") {
			return { approved: true };
		}

		const request = await this.opts.approvalManager.requestApproval(
			this.name,
			{ command, policy: decision },
			`Run ${decision.category} command: ${command}`,
		);
		const response = await this.opts.approvalManager.checkApproval(request);
		return { approved: response.approved, reason: response.reason };
	}

	private renderDenied(decision: ShellPolicyDecision): string {
		return [
			`Error: command denied`,
			`command: ${decision.command}`,
			`category: ${decision.category}`,
			`reason: ${decision.reason ?? decision.denyCode ?? "policy rejected"}`,
		].join("\n");
	}
}
