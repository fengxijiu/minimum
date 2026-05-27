import type {
	CapacityConfig,
	CapacityObservation,
	CapacitySnapshot,
	GuardrailAction,
	RiskBand,
} from "./types.js";

export class CapacityController {
	private config: CapacityConfig;
	private history: CapacitySnapshot[] = [];
	private lastRefreshTurn = 0;

	constructor(config?: Partial<CapacityConfig>) {
		this.config = {
			enabled: config?.enabled ?? true,
			lowRiskMax: config?.lowRiskMax ?? 0.5,
			mediumRiskMax: config?.mediumRiskMax ?? 0.62,
			severeMinSlack: config?.severeMinSlack ?? -0.25,
			refreshCooldownTurns: config?.refreshCooldownTurns ?? 6,
		};
	}

	observe(observation: CapacityObservation): CapacitySnapshot {
		const contextUsedRatio = observation.promptTokens / observation.maxTokens;
		const slack = 1 - contextUsedRatio;
		const riskBand = this.assessRisk(contextUsedRatio);
		const action = this.determineAction(riskBand, slack, observation.turnIndex);

		const snapshot: CapacitySnapshot = {
			turnIndex: observation.turnIndex,
			contextUsedRatio,
			riskBand,
			slack,
			action,
		};

		this.history.push(snapshot);
		return snapshot;
	}

	private assessRisk(contextUsedRatio: number): RiskBand {
		if (contextUsedRatio < this.config.lowRiskMax) {
			return "low";
		}
		if (contextUsedRatio < this.config.mediumRiskMax) {
			return "medium";
		}
		return "high";
	}

	private determineAction(
		riskBand: RiskBand,
		slack: number,
		turnIndex: number,
	): GuardrailAction {
		if (!this.config.enabled) {
			return "no_intervention";
		}

		if (riskBand === "high") {
			if (slack < this.config.severeMinSlack) {
				return "verify_and_replan";
			}
			return "targeted_refresh";
		}

		if (riskBand === "medium") {
			const turnsSinceRefresh = turnIndex - this.lastRefreshTurn;
			if (turnsSinceRefresh >= this.config.refreshCooldownTurns) {
				return "targeted_refresh";
			}
		}

		return "no_intervention";
	}

	recordRefresh(turnIndex: number): void {
		this.lastRefreshTurn = turnIndex;
	}

	getHistory(): CapacitySnapshot[] {
		return [...this.history];
	}

	getLastSnapshot(): CapacitySnapshot | undefined {
		return this.history[this.history.length - 1];
	}

	getConfig(): CapacityConfig {
		return { ...this.config };
	}

	updateConfig(config: Partial<CapacityConfig>): void {
		this.config = { ...this.config, ...config };
	}

	isEnabled(): boolean {
		return this.config.enabled;
	}

	enable(): void {
		this.config.enabled = true;
	}

	disable(): void {
		this.config.enabled = false;
	}
}
