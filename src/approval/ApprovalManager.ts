import type {
	ApprovalConfig,
	ApprovalMode,
	ApprovalRequest,
	ApprovalResponse,
	RiskLevel,
} from "./types.js";

// Tools that are always safe to run in any mode.
const LOW_RISK_TOOLS = new Set([
	"read_file",
	"list_directory",
	"glob",
	"grep",
	"search",
	"git_status",
	"git_diff",
	"git_log",
	"todo_write",
]);

// File-mutating tools — allowed in auto-edit mode without confirmation.
const EDIT_TOOLS = new Set(["write_file", "edit_file", "apply_patch"]);

// Dangerous shell patterns — always "high" risk.
const DANGEROUS_SHELL_RE = [
	/rm\s+-[rf]/,
	/sudo/,
	/chmod\s+777/,
	/mkfs/,
	/dd\s+/,
	/>\s*\/dev/,
	/curl.*\|\s*sh/,
	/wget.*\|\s*sh/,
];

/**
 * Hook to surface a confirmation prompt to a user. When set, the manager
 * delegates "needs confirmation" decisions to it instead of auto-denying.
 * EngineBridge wires this to the TUI's permission overlay.
 */
export type ApprovalPrompter = (
	request: ApprovalRequest,
) => Promise<ApprovalResponse>;

export class ApprovalManager {
	private config: ApprovalConfig;
	/** Per-exact-call memory (tool + serialised args) */
	private callHistory: Map<string, boolean> = new Map();
	/** Per-tool-name habit cache ("always allow" or "always block") */
	private habitCache: Map<string, "always" | "block"> = new Map();
	private nextId = 1;
	private prompter?: ApprovalPrompter;

	constructor(config?: Partial<ApprovalConfig>) {
		this.config = {
			mode: config?.mode || "suggest",
			autoApproveLowRisk: config?.autoApproveLowRisk ?? true,
			requireConfirmationFor: config?.requireConfirmationFor || [],
		};
	}

	async requestApproval(
		tool: string,
		args: Record<string, any>,
		description: string,
	): Promise<ApprovalRequest> {
		const risk = this.assessRisk(tool, args);
		return {
			id: `approval_${this.nextId++}`,
			tool,
			args,
			risk,
			description,
			timestamp: Date.now(),
		};
	}

	async checkApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
		// 1. Habit cache by tool name takes top priority.
		const habit = this.habitCache.get(request.tool);
		if (habit === "always")
			return {
				approved: true,
				reason: "Habit: always allow",
				remembered: true,
			};
		if (habit === "block")
			return {
				approved: false,
				reason: "Habit: always block",
				remembered: true,
			};

		// 2. Per-call history (exact args match).
		const callKey = `${request.tool}:${JSON.stringify(request.args)}`;
		if (this.callHistory.has(callKey)) {
			return {
				approved: this.callHistory.get(callKey)!,
				reason: "Previously decided",
				remembered: true,
			};
		}

		// 3. Mode-driven decision.
		switch (this.config.mode) {
			case "read-only":
				// Only low-risk reads pass.
				if (request.risk === "low")
					return { approved: true, reason: "read-only: safe read" };
				return {
					approved: false,
					reason: "read-only mode: writes and shell are blocked",
				};

			case "auto-edit":
				// File edits auto-approved; shell/high-risk needs confirmation.
				if (request.risk === "low" || EDIT_TOOLS.has(request.tool)) {
					return { approved: true, reason: "auto-edit: auto-approved" };
				}
				return this.ask(request, "auto-edit: shell requires confirmation");

			case "full-auto":
				return { approved: true, reason: "full-auto: unrestricted" };

			case "never":
				return { approved: false, reason: "never mode: all tools blocked" };
			default:
				if (this.config.autoApproveLowRisk && request.risk === "low") {
					return { approved: true, reason: "suggest: low risk auto-approved" };
				}
				return this.ask(request, "suggest: requires user confirmation");
		}
	}

	/** Delegate to prompter if set, else fall back to deny with the given reason. */
	private async ask(
		request: ApprovalRequest,
		denyReason: string,
	): Promise<ApprovalResponse> {
		if (!this.prompter) return { approved: false, reason: denyReason };
		const resp = await this.prompter(request);
		// Remember the decision for the rest of the session.
		this.recordApproval(request, resp.approved, resp.remembered ?? false);
		return resp;
	}

	setPrompter(fn: ApprovalPrompter | undefined): void {
		this.prompter = fn;
	}

	/**
	 * Push a prompter, returning a callback that restores the previous one.
	 * Used by PipelineBridge so orchestrate mode can route approvals through
	 * the pipeline event stream without permanently overwriting the
	 * single-agent prompter installed by EngineBridge.
	 */
	pushPrompter(fn: ApprovalPrompter): () => void {
		const prev = this.prompter;
		this.prompter = fn;
		return () => {
			// Only restore if no one else has swapped the prompter since —
			// last-writer-wins keeps the API simple.
			if (this.prompter === fn) this.prompter = prev;
		};
	}

	/**
	 * Record a per-call approval decision (keyed by tool+args).
	 * Call with `remember=true` to also populate the habit cache by tool name.
	 */
	recordApproval(
		request: ApprovalRequest,
		approved: boolean,
		remember = false,
	): void {
		const callKey = `${request.tool}:${JSON.stringify(request.args)}`;
		this.callHistory.set(callKey, approved);
		if (remember) {
			this.habitCache.set(request.tool, approved ? "always" : "block");
		}
	}

	/**
	 * Directly set a per-tool habit ("always allow" or "always block").
	 * Exposed so the TUI can wire "always for X" keyboard shortcut.
	 */
	rememberHabit(toolName: string, decision: "always" | "block"): void {
		this.habitCache.set(toolName, decision);
	}

	/** Forget all habit-cache entries (keeps per-call history). */
	clearHabits(): void {
		this.habitCache.clear();
	}

	getMode(): ApprovalMode {
		return this.config.mode;
	}

	setMode(mode: ApprovalMode): void {
		this.config.mode = mode;
	}

	getConfig(): ApprovalConfig {
		return { ...this.config };
	}

	updateConfig(config: Partial<ApprovalConfig>): void {
		this.config = { ...this.config, ...config };
	}

	private assessRisk(tool: string, args: Record<string, any>): RiskLevel {
		if (LOW_RISK_TOOLS.has(tool)) return "low";
		if (tool === "exec_shell") {
			const cmd = String(args.command ?? "");
			if (DANGEROUS_SHELL_RE.some((r) => r.test(cmd))) return "high";
			return "medium";
		}
		if (EDIT_TOOLS.has(tool)) return "medium";
		// All git operations route through the single "git" tool with a
		// subcommand in args — the standalone tool names "git_push"/"git_commit"
		// don't exist in the registry, so we have to inspect the subcommand.
		if (tool === "git") {
			const sub = String(args.subcommand ?? "").toLowerCase();
			if (sub === "push" || sub === "commit") return "high";
			return "medium";
		}
		return "medium";
	}
}
