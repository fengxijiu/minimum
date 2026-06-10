import type { ChatMessage, ToolDefinition } from "../types/common.js";

/** Token Plan API keys begin with "tp-"; pay-as-you-go keys begin with "sk-". */
export function resolveBaseUrl(apiKey: string, explicit?: string): string {
	if (explicit) return explicit;
	return apiKey.startsWith("tp-")
		? "https://token-plan-cn.xiaomimimo.com/v1"
		: "https://api.xiaomimimo.com/v1";
}

export interface MiMoApiConcurrencyConfig {
	/** 0 or undefined means no steady-state concurrency cap. */
	maxConcurrent?: number;
	/** Temporary concurrency cap activated after a 429 response. */
	throttleOn429MaxConcurrent?: number;
	/** How long the temporary 429 cap stays active. */
	throttleWindowMs?: number;
}

export interface MiMoClientOptions {
	apiKey?: string;
	baseUrl?: string;
	model?: string;
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	apiConcurrency?: MiMoApiConcurrencyConfig;
	thinking?: {
		type: "enabled" | "disabled";
		budget_tokens?: number;
	};
}

export interface ChatOptions {
	messages: ChatMessage[];
	tools?: ToolDefinition[];
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	signal?: AbortSignal;
	stream?: boolean;
	thinking?: {
		type: "enabled" | "disabled";
		budget_tokens?: number;
	};
}

export interface ChatResponse {
	id: string;
	content: string;
	reasoningContent?: string;
	toolCalls?: Array<{
		id: string;
		type: "function";
		function: {
			name: string;
			arguments: string;
		};
	}>;
	finishReason: string;
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		reasoningTokens?: number;
		cachedTokens?: number;
	};
	webSearchUsage?: {
		toolUsage: number;
		pageUsage: number;
	};
}

export interface StreamChunk {
	type: "content" | "reasoning" | "tool_call" | "usage" | "error" | "done";
	content?: string;
	toolCall?: {
		id: string;
		type: "function";
		function: {
			name: string;
			arguments: string;
		};
	};
	usage?: ChatResponse["usage"];
	error?: string;
}

const DEFAULT_API_CONCURRENCY: Required<MiMoApiConcurrencyConfig> = {
	maxConcurrent: 0,
	throttleOn429MaxConcurrent: 20,
	throttleWindowMs: 60_000,
};

class ApiConcurrencyGate {
	private config: Required<MiMoApiConcurrencyConfig>;
	private active = 0;
	private reducedUntil = 0;
	private waiters: Array<() => void> = [];
	private wakeTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(config?: MiMoApiConcurrencyConfig) {
		this.config = { ...DEFAULT_API_CONCURRENCY, ...config };
	}

	configure(config?: MiMoApiConcurrencyConfig): void {
		this.config = { ...this.config, ...config };
		this.scheduleWake();
		this.wakeQueued();
	}

	getConfig(): Required<MiMoApiConcurrencyConfig> {
		return { ...this.config };
	}

	noteRateLimit(statusCode: number): void {
		if (statusCode !== 429) return;
		const nextUntil = Date.now() + this.config.throttleWindowMs;
		if (nextUntil > this.reducedUntil) {
			this.reducedUntil = nextUntil;
			this.scheduleWake();
		}
		this.wakeQueued();
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		while (true) {
			if (signal?.aborted) throw abortedError();
			if (this.active < this.currentLimit()) {
				this.active += 1;
				let released = false;
				return () => {
					if (released) return;
					released = true;
					this.active = Math.max(0, this.active - 1);
					this.wakeQueued();
				};
			}
			await this.waitForSlot(signal);
		}
	}

	private currentLimit(): number {
		const reduced = Date.now() < this.reducedUntil;
		const limit = reduced
			? this.config.throttleOn429MaxConcurrent
			: this.config.maxConcurrent;
		return limit > 0 ? limit : Number.POSITIVE_INFINITY;
	}

	private waitForSlot(signal?: AbortSignal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const wake = () => {
				if (signal) signal.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = () => {
				this.waiters = this.waiters.filter((waiter) => waiter !== wake);
				reject(abortedError());
			};
			if (signal?.aborted) {
				reject(abortedError());
				return;
			}
			this.waiters.push(wake);
			if (signal) signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	private wakeQueued(): void {
		while (this.waiters.length > 0 && this.active < this.currentLimit()) {
			const waiter = this.waiters.shift();
			waiter?.();
		}
	}

	private scheduleWake(): void {
		if (this.wakeTimer) {
			clearTimeout(this.wakeTimer);
			this.wakeTimer = null;
		}
		if (Date.now() >= this.reducedUntil) return;
		const delay = Math.max(0, this.reducedUntil - Date.now());
		this.wakeTimer = setTimeout(() => {
			this.wakeTimer = null;
			this.wakeQueued();
		}, delay);
	}
}

function abortedError(): Error {
	const error = new Error("Request aborted while waiting for API concurrency slot");
	error.name = "AbortError";
	return error;
}

/**
 * MiMo API Client - OpenAI-compatible protocol.
 *
 * Supports:
 * - Pay-as-you-go API (sk-xxx): https://api.xiaomimimo.com/v1
 * - Token Plan (tp-xxx): https://token-plan-cn.xiaomimimo.com/v1
 *
 * Reference: https://platform.xiaomimimo.com/docs/zh-CN/api/chat/openai-api
 */
export class MiMoClient {
	private apiKey: string;
	private baseUrl: string;
	private model: string;
	private maxTokens: number;
	private temperature: number;
	private topP: number;
	private apiConcurrency: ApiConcurrencyGate;
	private thinking?: { type: "enabled" | "disabled"; budget_tokens?: number };

	constructor(options: MiMoClientOptions = {}) {
		this.apiKey = options.apiKey || process.env.MIMO_API_KEY || "";
		this.baseUrl = resolveBaseUrl(
			this.apiKey,
			options.baseUrl || process.env.MIMO_BASE_URL,
		);
		this.model = options.model || "mimo-v2.5-pro";
		this.maxTokens = options.maxTokens || 131072;
		this.temperature = options.temperature ?? 0.3;
		this.topP = options.topP ?? 0.95;
		this.apiConcurrency = new ApiConcurrencyGate(options.apiConcurrency);
		this.thinking = options.thinking;
	}

	/**
	 * Non-streaming chat.
	 */
	async chat(options: ChatOptions): Promise<ChatResponse> {
		const body = this.buildRequestBody(options, false);
		const release = await this.apiConcurrency.acquire(options.signal);

		try {
			const response = await fetch(`${this.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"api-key": this.apiKey,
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify(body),
				signal: options.signal,
			});

			if (!response.ok) {
				this.apiConcurrency.noteRateLimit(response.status);
				const error = await response.text();
				throw new MiMoApiError(response.status, error);
			}

			const data = (await response.json()) as any;
			return this.parseResponse(data);
		} finally {
			release();
		}
	}

	/**
	 * Streaming chat.
	 */
	async *streamChat(options: ChatOptions): AsyncGenerator<StreamChunk> {
		const body = this.buildRequestBody(options, true);
		const retryable = new Set([429, 503, 529]);
		const release = await this.apiConcurrency.acquire(options.signal);

		try {
			// Keep the slot for the full streaming session so worker/planner
			// calls share the same backpressure after a 429 burst.
			let response!: Response;
			for (let attempt = 0; attempt < 6; attempt++) {
				if (attempt > 0) {
					const cap = Math.min(2_000 * 2 ** (attempt - 1), 32_000);
					const delay = Math.round(cap * Math.random());
					await new Promise<void>((r) => setTimeout(r, delay));
				}
				const next = await fetch(`${this.baseUrl}/chat/completions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"api-key": this.apiKey,
						Authorization: `Bearer ${this.apiKey}`,
					},
					body: JSON.stringify(body),
					signal: options.signal,
				});
				if (next.ok) {
					response = next;
					break;
				}
				this.apiConcurrency.noteRateLimit(next.status);
				if (!retryable.has(next.status) || attempt >= 5) {
					const error = await next.text();
					throw new MiMoApiError(next.status, error);
				}
			}

			const reader = response.body?.getReader();
			if (!reader) {
				throw new Error("No response body");
			}

			const decoder = new TextDecoder();
			let buffer = "";
			let currentToolCall: any = null;
			const completedToolCalls: any[] = [];
			const flushToolCalls = function* (): Generator<StreamChunk> {
				if (currentToolCall) {
					completedToolCalls.push(currentToolCall);
					currentToolCall = null;
				}
				for (const tc of completedToolCalls) {
					yield { type: "tool_call", toolCall: tc };
				}
				completedToolCalls.length = 0;
			};

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;

					const data = line.slice(6).trim();
					if (data === "[DONE]") {
						yield* flushToolCalls();
						yield { type: "done" };
						return;
					}

					try {
						const parsed = JSON.parse(data);
						const choice = parsed.choices?.[0];
						if (!choice) continue;

						const delta = choice.delta;

						if (delta?.content) {
							yield { type: "content", content: delta.content };
						}

						if (delta?.reasoning_content) {
							yield { type: "reasoning", content: delta.reasoning_content };
						}

						if (delta?.tool_calls) {
							for (const tc of delta.tool_calls) {
								if (tc.id) {
									if (currentToolCall) {
										completedToolCalls.push(currentToolCall);
									}
									currentToolCall = {
										id: tc.id,
										type: "function",
										function: {
											name: tc.function?.name || "",
											arguments: tc.function?.arguments || "",
										},
									};
								} else if (currentToolCall) {
									currentToolCall.function.arguments +=
										tc.function?.arguments || "";
								}
							}
						}

						if (choice.finish_reason === "tool_calls") {
							if (currentToolCall) {
								completedToolCalls.push(currentToolCall);
								currentToolCall = null;
							}
							for (const tc of completedToolCalls) {
								yield { type: "tool_call", toolCall: tc };
							}
							completedToolCalls.length = 0;
						}

						if (parsed.usage) {
							yield {
								type: "usage",
								usage: {
									promptTokens: parsed.usage.prompt_tokens,
									completionTokens: parsed.usage.completion_tokens,
									totalTokens: parsed.usage.total_tokens,
									reasoningTokens:
										parsed.usage.completion_tokens_details?.reasoning_tokens,
									cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens,
								},
							};
						}
					} catch {
						// Skip malformed JSON
					}
				}
			}

			// Some SSE implementations close the response body without sending the
			// final [DONE] sentinel. Preserve any complete tool call accumulated
			// before EOF and still surface a terminal done event to callers.
			yield* flushToolCalls();
			yield { type: "done" };
		} finally {
			release();
		}
	}

	/**
	 * Build a request body that matches the MiMo OpenAI-compatible API.
	 */
	private buildRequestBody(options: ChatOptions, stream: boolean): any {
		const body: any = {
			model: this.model,
			messages: this.formatMessages(options.messages),
			max_completion_tokens: options.maxTokens || this.maxTokens,
			temperature: options.temperature ?? this.temperature,
			top_p: options.topP ?? this.topP,
			stream,
			frequency_penalty: 0,
			presence_penalty: 0,
		};

		if (options.tools && options.tools.length > 0) {
			body.tools = options.tools
				.slice()
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((tool) => ({
					type: "function",
					function: {
						name: tool.name,
						description: tool.description || "",
						parameters: tool.parameters || { type: "object", properties: {} },
					},
				}));
			body.tool_choice = "auto";
		}

		if (options.thinking || this.thinking) {
			body.thinking = options.thinking || this.thinking;
		}

		return body;
	}

	/**
	 * Format messages, including tool_calls and reasoning_content.
	 */
	private formatMessages(messages: ChatMessage[]): any[] {
		return messages.map((msg) => {
			const formatted: any = {
				role: msg.role,
				content: msg.content,
			};

			if (msg.tool_calls) {
				formatted.tool_calls = msg.tool_calls;
			}

			if (msg.tool_call_id) {
				formatted.tool_call_id = msg.tool_call_id;
			}

			if (msg.reasoning_content) {
				formatted.reasoning_content = msg.reasoning_content;
			}

			return formatted;
		});
	}

	/**
	 * Parse a non-streaming API response.
	 */
	private parseResponse(data: any): ChatResponse {
		const choice = data.choices?.[0];
		if (!choice) {
			throw new Error("No choice in response");
		}

		return {
			id: data.id,
			content: choice.message?.content || "",
			reasoningContent: choice.message?.reasoning_content,
			toolCalls: choice.message?.tool_calls?.map((tc: any) => ({
				id: tc.id,
				type: "function",
				function: {
					name: tc.function.name,
					arguments: tc.function.arguments,
				},
			})),
			finishReason: choice.finish_reason,
			usage: {
				promptTokens: data.usage?.prompt_tokens || 0,
				completionTokens: data.usage?.completion_tokens || 0,
				totalTokens: data.usage?.total_tokens || 0,
				reasoningTokens:
					data.usage?.completion_tokens_details?.reasoning_tokens,
				cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
			},
			webSearchUsage: data.usage?.web_search_usage,
		};
	}

	/**
	 * Return the current configuration with secrets redacted.
	 */
	getConfig(): MiMoClientOptions {
		return {
			apiKey: "***",
			baseUrl: this.baseUrl,
			model: this.model,
			maxTokens: this.maxTokens,
			temperature: this.temperature,
			topP: this.topP,
			apiConcurrency: this.apiConcurrency.getConfig(),
			thinking: this.thinking,
		};
	}

	setApiConcurrency(config?: MiMoApiConcurrencyConfig): void {
		this.apiConcurrency.configure(config);
	}

	/** Configured model id - used by MiMoLoop to look up pricing. */
	getModel(): string {
		return this.model;
	}

	/** Maximum completion tokens this client is configured to request. */
	getMaxTokens(): number {
		return this.maxTokens;
	}

	/** "tp-" -> Token Plan (Credits); anything else -> API pay-as-you-go (CNY). */
	getBillingMode(): "api" | "tokenPlan" {
		return this.apiKey.startsWith("tp-") ? "tokenPlan" : "api";
	}
}

/**
 * MiMo API error.
 */
export class MiMoApiError extends Error {
	constructor(
		public statusCode: number,
		public responseBody: string,
	) {
		super(`MiMo API error ${statusCode}: ${responseBody}`);
		this.name = "MiMoApiError";
	}
}
