import type { LoopState } from "./MiMoLoop.js";

export class LoopStateManager {
	private state: LoopState = {
		running: false,
		currentStep: 0,
		totalTokens: 0,
		totalCostUsd: 0,
		toolCalls: 0,
		errors: 0,
	};

	getState(): LoopState {
		return { ...this.state };
	}

	setRunning(running: boolean): void {
		this.state.running = running;
	}

	incrementStep(): void {
		this.state.currentStep++;
	}

	addTokens(tokens: number): void {
		this.state.totalTokens += tokens;
	}

	addCost(cost: number): void {
		this.state.totalCostUsd += cost;
	}

	incrementToolCalls(): void {
		this.state.toolCalls++;
	}

	incrementErrors(): void {
		this.state.errors++;
	}

	reset(): void {
		this.state = {
			running: false,
			currentStep: 0,
			totalTokens: 0,
			totalCostUsd: 0,
			toolCalls: 0,
			errors: 0,
		};
	}
}
