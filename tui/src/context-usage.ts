export interface ContextUsageLike {
	contextTokens?: number;
	promptTokens?: number;
	totalTokens?: number;
}

export function getContextUsageK(usage: ContextUsageLike): number {
	// NEW: prefer live context occupancy; only fall back to prompt tokens for
	// older engine payloads that have not started emitting contextTokens yet.
	const tokens = usage.contextTokens ?? usage.promptTokens ?? 0;
	return Number((tokens / 1000).toFixed(1));
}
