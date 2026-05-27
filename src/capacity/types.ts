export type RiskBand = "low" | "medium" | "high";
export type GuardrailAction =
	| "no_intervention"
	| "targeted_refresh"
	| "verify_and_replan";

export interface CapacityConfig {
	enabled: boolean;
	lowRiskMax: number;
	mediumRiskMax: number;
	severeMinSlack: number;
	refreshCooldownTurns: number;
}

export interface CapacitySnapshot {
	turnIndex: number;
	contextUsedRatio: number;
	riskBand: RiskBand;
	slack: number;
	action: GuardrailAction;
}

export interface CapacityObservation {
	turnIndex: number;
	promptTokens: number;
	maxTokens: number;
	toolCalls: number;
}
