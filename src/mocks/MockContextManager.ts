export interface ChatMessage {
	role: string;
	content: string;
	tool_calls?: any[];
	tool_call_id?: string;
}

export interface TaskState {
	objective: string;
	currentStep: number;
	totalSteps?: number;
	completedSubtasks: string[];
	pendingSubtasks: string[];
}

export interface ContextOptimizeRequest {
	messages: ChatMessage[];
	taskState: TaskState;
	maxTokens: number;
	currentTokens?: number;
	strategy?: string;
}

export interface ContextOptimizeResult {
	messages: ChatMessage[];
	folded: boolean;
	originalCount: number;
	foldedCount: number;
	retainedInfo: any;
	summaryMessage?: ChatMessage;
	tokens: {
		before: number;
		after: number;
		saved: number;
	};
}

export class MockContextManager {
	private shouldFoldResult = false;

	setShouldFold(shouldFold: boolean): void {
		this.shouldFoldResult = shouldFold;
	}

	async optimize(
		request: ContextOptimizeRequest,
	): Promise<ContextOptimizeResult> {
		const currentTokens =
			request.currentTokens || this.countTokens(request.messages);

		if (this.shouldFoldResult) {
			const summaryMessage: ChatMessage = {
				role: "assistant",
				content: `[Context folded]\nObjective: ${request.taskState.objective}`,
			};

			const firstMessage = request.messages[0] || {
				role: "system",
				content: "",
			};
			return {
				messages: [firstMessage, summaryMessage, ...request.messages.slice(-3)],
				folded: true,
				originalCount: request.messages.length,
				foldedCount: 4,
				retainedInfo: {
					taskObjective: request.taskState.objective,
					decisions: [],
					fileChanges: [],
					errors: [],
					constraints: [],
					partialResults: [],
				},
				summaryMessage,
				tokens: {
					before: currentTokens,
					after: Math.floor(currentTokens * 0.5),
					saved: Math.floor(currentTokens * 0.5),
				},
			};
		}

		return {
			messages: request.messages,
			folded: false,
			originalCount: request.messages.length,
			foldedCount: request.messages.length,
			retainedInfo: null,
			tokens: {
				before: currentTokens,
				after: currentTokens,
				saved: 0,
			},
		};
	}

	async extractKeyInfo(
		messages: ChatMessage[],
		taskState: TaskState,
	): Promise<any> {
		return {
			taskObjective: taskState.objective,
			decisions: [],
			fileChanges: [],
			errors: [],
			constraints: [],
			partialResults: [],
		};
	}

	async generateSummary(
		messages: ChatMessage[],
		keyInfo: any,
	): Promise<string> {
		return "Mock summary";
	}

	countTokens(messages: ChatMessage[]): number {
		return messages.reduce(
			(acc, msg) => acc + (msg.content?.length || 0) / 4,
			0,
		);
	}

	shouldFold(currentTokens: number, maxTokens: number): boolean {
		return this.shouldFoldResult || currentTokens > maxTokens * 0.75;
	}
}
