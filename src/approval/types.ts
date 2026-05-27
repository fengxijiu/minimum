export type RiskLevel = "low" | "medium" | "high";

export interface ApprovalRequest {
	id: string;
	tool: string;
	args: Record<string, any>;
	risk: RiskLevel;
	description: string;
	timestamp: number;
}

export interface ApprovalResponse {
	approved: boolean;
	reason?: string;
	remember?: boolean;
}

export type ApprovalMode = "auto" | "suggest" | "never";

export interface ApprovalConfig {
	mode: ApprovalMode;
	autoApproveLowRisk: boolean;
	requireConfirmationFor: string[];
}
