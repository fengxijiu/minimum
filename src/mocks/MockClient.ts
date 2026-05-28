import type {
	ChatOptions,
	ChatResponse,
	MiMoClientOptions,
	StreamChunk,
} from "../clients/MiMoClient.js";

export type { StreamChunk };

/**
 * A test double for MiMoClient that implements the same public interface
 * (`chat`, `streamChat`, `getConfig`) and provides helpers for scripted
 * responses in tests.
 *
 * Usage:
 *   const client = new MockClient();
 *   client.setDefaultResponse('ok');
 *
 *   // Or script exact chunk sequences:
 *   const client = MockClient.fromTurns([
 *     [{ type: 'content', content: 'hello' }],
 *     [{ type: 'content', content: 'world' }],
 *   ]);
 *
 *   // Or set tool calls for a specific prompt:
 *   client.setToolCalls('do it', [{ id: 't1', name: 'read_file', arguments: { path: 'a.ts' } }]);
 */
export class MockClient {
	private responses: Map<string, string> = new Map();
	private callHistory: ChatOptions[] = [];
	private defaultResponse = "Mock response";
	private toolCalls: Map<
		string,
		Array<{ id: string; name: string; arguments: Record<string, unknown> }>
	> = new Map();
	private scriptedTurns: StreamChunk[][] = [];

	// ------------------------------------------------------------------
	// Test-setup helpers
	// ------------------------------------------------------------------

	setDefaultResponse(response: string): void {
		this.defaultResponse = response;
	}

	/** Map a specific user-prompt substring to a canned text response. */
	setResponse(prompt: string, response: string): void {
		this.responses.set(prompt, response);
	}

	/**
	 * Register tool calls that will be yielded when the user's last message
	 * contains the given substring.
	 */
	setToolCalls(
		prompt: string,
		calls: Array<{
			id: string;
			name: string;
			arguments: Record<string, unknown>;
		}>,
	): void {
		this.toolCalls.set(prompt, calls);
	}

	/** Record a script of turns to replay. Each call to streamChat pops one. */
	setScriptedTurns(turns: StreamChunk[][]): void {
		this.scriptedTurns = [...turns];
	}

	getCallHistory(): ChatOptions[] {
		return this.callHistory;
	}

	clearHistory(): void {
		this.callHistory = [];
	}

	// ------------------------------------------------------------------
	// Static factories
	// ------------------------------------------------------------------

	/**
	 * Create a MockClient pre-loaded with scripted turn data.
	 * Each turn is an array of StreamChunk objects replayed in order.
	 */
	static fromTurns(turns: StreamChunk[][]): MockClient {
		const client = new MockClient();
		client.setScriptedTurns(turns);
		return client;
	}

	// ------------------------------------------------------------------
	// MiMoClient-compatible interface
	// ------------------------------------------------------------------

	async chat(options: ChatOptions): Promise<ChatResponse> {
		this.callHistory.push(options);

		const lastMessage = options.messages[options.messages.length - 1];
		const lastContent =
			typeof lastMessage?.content === "string" ? lastMessage.content : "";
		const response =
			(lastContent ? this.responses.get(lastContent) : undefined) ||
			this.defaultResponse;

		return {
			id: `mock-${Date.now()}`,
			content: response,
			finishReason: "stop",
			usage: {
				promptTokens: 100,
				completionTokens: 50,
				totalTokens: 150,
			},
		};
	}

	async *streamChat(options: ChatOptions): AsyncGenerator<StreamChunk> {
		this.callHistory.push(options);

		// If scripted turns are queued, replay the next one.
		if (this.scriptedTurns.length > 0) {
			const turn = this.scriptedTurns.shift()!;
			for (const chunk of turn) {
				yield chunk;
			}
			yield {
				type: "usage",
				usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
			};
			yield { type: "done" };
			return;
		}

		const lastMessage = options.messages[options.messages.length - 1];
		const lastContent =
			typeof lastMessage?.content === "string" ? lastMessage.content : "";

		// Yield tool calls if registered for this prompt.
		const matchedCalls = lastContent
			? this.findMatchingValue(this.toolCalls, lastContent)
			: undefined;
		if (matchedCalls && matchedCalls.length > 0) {
			for (const tc of matchedCalls) {
				yield {
					type: "tool_call",
					toolCall: {
						id: tc.id,
						type: "function",
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						},
					},
				};
			}
			yield {
				type: "usage",
				usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
			};
			yield { type: "done" };
			return;
		}

		// Otherwise yield text content.
		const response =
			(lastContent ? this.responses.get(lastContent) : undefined) ||
			this.defaultResponse;

		if (response) {
			yield { type: "content", content: response };
		}

		yield {
			type: "usage",
			usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
		};
		yield { type: "done" };
	}

	getConfig(): MiMoClientOptions {
		return {
			apiKey: "***",
			baseUrl: "https://mock.test/v1",
			model: "mock-model",
			maxTokens: 131072,
			temperature: 1.0,
			topP: 0.95,
		};
	}

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	/** Find the first map entry whose key is a substring of `text`. */
	private findMatchingValue<V>(
		map: Map<string, V>,
		text: string,
	): V | undefined {
		for (const [key, value] of map) {
			if (text.includes(key)) return value;
		}
		return undefined;
	}
}
