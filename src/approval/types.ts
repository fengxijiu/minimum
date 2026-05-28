export type RiskLevel = "low" | "medium" | "high";

/**
 * Three-tier approval mode (Codex-style) plus two legacy modes.
 *
 *  read-only  — only safe read tools pass; all writes/shell blocked
 *  auto-edit  — file edits (write/edit/apply_patch) auto-approved; shell requires confirmation
 *  full-auto  — everything auto-approved (use inside a sandbox)
 *  suggest    — (legacy) interactive; low-risk auto-approved, rest blocked
 *  never      — (legacy) block everything
 */
export type ApprovalMode = "read-only" | "auto-edit" | "full-auto" | "suggest" | "never";

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
	/** If true, the decision was stored in the habit cache. */
	remembered?: boolean;
}

export interface ApprovalConfig {
	mode: ApprovalMode;
	autoApproveLowRisk: boolean;
	requireConfirmationFor: string[];
}
