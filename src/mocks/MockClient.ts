export interface ChatOptions {
	messages: Array<{ role: string; content: string }>;
	tools?: any[];
	max_tokens?: number;
	temperature?: number;
}

export interface ChatResponse {
	content: string;
	tool_calls?: any[];
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
}

export class MockClient {
	private responses: Map<string, string> = new Map();
	private callHistory: ChatOptions[] = [];
	private defaultResponse = "Mock response";

	setDefaultResponse(response: string): void {
		this.defaultResponse = response;
	}

	setResponse(prompt: string, response: string): void {
		this.responses.set(prompt, response);
	}

	async chat(options: ChatOptions): Promise<ChatResponse> {
		this.callHistory.push(options);

		const lastMessage = options.messages[options.messages.length - 1];
		const response =
			(lastMessage ? this.responses.get(lastMessage.content) : undefined) ||
			this.defaultResponse;

		return {
			content: response,
			usage: {
				promptTokens: 100,
				completionTokens: 50,
				totalTokens: 150,
			},
		};
	}

	getCallHistory(): ChatOptions[] {
		return this.callHistory;
	}

	clearHistory(): void {
		this.callHistory = [];
	}
}
