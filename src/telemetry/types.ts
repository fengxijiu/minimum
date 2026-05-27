export interface UsageStats {
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
	totalCost: number;
	toolCalls: number;
	errors: number;
	startTime: number;
	endTime?: number;
}

export interface TurnStats {
	turnIndex: number;
	tokens: number;
	cost: number;
	toolCalls: number;
	duration: number;
	success: boolean;
}

export interface SessionStats {
	sessionId: string;
	turns: TurnStats[];
	totalTokens: number;
	totalCost: number;
	startTime: number;
	endTime?: number;
}
