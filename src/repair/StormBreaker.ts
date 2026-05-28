import type { ToolCall } from "../types/common.js";

export type IsMutating = (call: ToolCall) => boolean;
export type IsStormExempt = (call: ToolCall) => boolean;

interface RecentEntry {
	name: string;
	args: string;
	readOnly: boolean;
	timestamp: number;
}

export interface StormConfig {
	windowSize: number;
	threshold: number;
}

export class StormBreaker {
	private readonly windowSize: number;
	private readonly threshold: number;
	private readonly isMutating: IsMutating | undefined;
	private readonly isStormExempt: IsStormExempt | undefined;
	private readonly recent: RecentEntry[] = [];

	constructor(
		config?: StormConfig,
		isMutating?: IsMutating,
		isStormExempt?: IsStormExempt,
	) {
		this.windowSize = config?.windowSize || 6;
		this.threshold = config?.threshold || 3;
		this.isMutating = isMutating;
		this.isStormExempt = isStormExempt;
	}

	inspect(call: ToolCall): { suppress: boolean; reason?: string } {
		const name = call.function?.name;
		if (!name) return { suppress: false };

		if (this.isStormExempt?.(call)) {
			return { suppress: false };
		}

		const args = call.function?.arguments ?? "";
		const mutating = this.isMutating ? this.isMutating(call) : false;
		const readOnly = !mutating;

		if (mutating) {
			for (let i = this.recent.length - 1; i >= 0; i--) {
				if (this.recent[i]?.readOnly) {
					this.recent.splice(i, 1);
				}
			}
		}

		const count = this.recent.reduce(
			(n, e) => (e.name === name && e.args === args ? n + 1 : n),
			0,
		);

		if (count >= this.threshold - 1) {
			return {
				suppress: true,
				reason: `${name} called with identical args ${count + 1} times — repeat-loop guard tripped`,
			};
		}

		this.recent.push({ name, args, readOnly, timestamp: Date.now() });

		while (this.recent.length > this.windowSize) {
			this.recent.shift();
		}

		return { suppress: false };
	}

	/**
	 * Inspect a batch of tool calls, returning per-call suppression status.
	 * Calls are inspected in order; each accepted call updates the window.
	 */
	inspectBatch(
		calls: ToolCall[],
	): { suppressed: boolean[]; reasons: (string | undefined)[] } {
		const suppressed: boolean[] = [];
		const reasons: (string | undefined)[] = [];
		for (const call of calls) {
			const result = this.inspect(call);
			suppressed.push(result.suppress);
			reasons.push(result.reason);
		}
		return { suppressed, reasons };
	}

	reset(): void {
		this.recent.length = 0;
	}

	getHistory(): RecentEntry[] {
		return [...this.recent];
	}
}
