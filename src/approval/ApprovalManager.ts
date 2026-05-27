import type {
	ApprovalConfig,
	ApprovalRequest,
	ApprovalResponse,
	RiskLevel,
} from "./types.js";

export class ApprovalManager {
	private config: ApprovalConfig;
	private history: Map<string, boolean> = new Map();
	private nextId = 1;

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

		const request: ApprovalRequest = {
			id: `approval_${this.nextId++}`,
			tool,
			args,
			risk,
			description,
			timestamp: Date.now(),
		};

		return request;
	}

	async checkApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
		// 检查记忆的审批
		const key = `${request.tool}:${JSON.stringify(request.args)}`;
		if (this.history.has(key)) {
			return {
				approved: this.history.get(key)!,
				reason: "Previously approved",
			};
		}

		// 自动审批低风险
		if (this.config.autoApproveLowRisk && request.risk === "low") {
			return { approved: true, reason: "Low risk auto-approve" };
		}

		// 自动模式
		if (this.config.mode === "auto") {
			return { approved: true, reason: "Auto mode" };
		}

		// 永不模式
		if (this.config.mode === "never") {
			return { approved: false, reason: "Never mode" };
		}

		// 建议模式 - 需要用户确认
		return { approved: false, reason: "Requires user confirmation" };
	}

	recordApproval(
		request: ApprovalRequest,
		approved: boolean,
		remember = false,
	): void {
		if (remember) {
			const key = `${request.tool}:${JSON.stringify(request.args)}`;
			this.history.set(key, approved);
		}
	}

	private assessRisk(tool: string, args: Record<string, any>): RiskLevel {
		// 高风险工具
		const highRiskTools = ["exec_shell", "write_file", "edit_file", "git_push"];
		if (highRiskTools.includes(tool)) {
			// 检查是否是危险操作
			if (tool === "exec_shell") {
				const command = args.command || "";
				if (this.isDangerousCommand(command)) {
					return "high";
				}
			}
			return "medium";
		}

		// 低风险工具
		const lowRiskTools = [
			"read_file",
			"list_directory",
			"glob",
			"grep",
			"git_status",
			"git_diff",
			"git_log",
		];
		if (lowRiskTools.includes(tool)) {
			return "low";
		}

		return "medium";
	}

	private isDangerousCommand(command: string): boolean {
		const dangerousPatterns = [
			/rm\s+-rf/,
			/sudo/,
			/chmod\s+777/,
			/mkfs/,
			/dd\s+/,
			/>\s*\/dev/,
			/curl.*\|\s*sh/,
			/wget.*\|\s*sh/,
		];

		return dangerousPatterns.some((pattern) => pattern.test(command));
	}

	getConfig(): ApprovalConfig {
		return { ...this.config };
	}

	updateConfig(config: Partial<ApprovalConfig>): void {
		this.config = { ...this.config, ...config };
	}
}
