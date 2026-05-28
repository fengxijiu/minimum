import type { ChatMessage, ToolDefinition } from "../types/common.js";

export interface MiMoClientOptions {
	apiKey?: string;
	baseUrl?: string;
	model?: string;
	maxTokens?: number;
	temperature?: number;
	topP?: number;
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

/**
 * MiMo API Client - OpenAI 兼容协议
 *
 * 支持：
 * - 按量付费 API (sk-xxx): https://api.xiaomimimo.com/v1
 * - Token Plan (tp-xxx): https://token-plan-cn.xiaomimimo.com/v1
 *
 * 参考文档：https://platform.xiaomimimo.com/docs/zh-CN/api/chat/openai-api
 */
export class MiMoClient {
	private apiKey: string;
	private baseUrl: string;
	private model: string;
	private maxTokens: number;
	private temperature: number;
	private topP: number;
	private thinking?: { type: "enabled" | "disabled"; budget_tokens?: number };

	constructor(options: MiMoClientOptions = {}) {
		this.apiKey = options.apiKey || process.env.MIMO_API_KEY || "";
		this.baseUrl =
			options.baseUrl ||
			process.env.MIMO_BASE_URL ||
			"https://api.xiaomimimo.com/v1";
		this.model = options.model || "mimo-v2.5-pro";
		this.maxTokens = options.maxTokens || 131072;
		this.temperature = options.temperature ?? 1.0;
		this.topP = options.topP ?? 0.95;
		this.thinking = options.thinking;
	}

	/**
	 * 非流式对话
	 */
	async chat(options: ChatOptions): Promise<ChatResponse> {
		const body = this.buildRequestBody(options, false);

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"api-key": this.apiKey,
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new MiMoApiError(response.status, error);
		}

		const data = (await response.json()) as any;
		return this.parseResponse(data);
	}

	/**
	 * 流式对话
	 */
	async *streamChat(options: ChatOptions): AsyncGenerator<StreamChunk> {
		const body = this.buildRequestBody(options, true);

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"api-key": this.apiKey,
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new MiMoApiError(response.status, error);
		}

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("No response body");
		}

		const decoder = new TextDecoder();
		let buffer = "";
		let currentToolCall: any = null;
		const completedToolCalls: any[] = [];

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
					// Yield any remaining accumulated tool calls
					if (currentToolCall) {
						completedToolCalls.push(currentToolCall);
						currentToolCall = null;
					}
					for (const tc of completedToolCalls) {
						yield { type: "tool_call", toolCall: tc };
					}
					yield { type: "done" };
					return;
				}

				try {
					const parsed = JSON.parse(data);
					const choice = parsed.choices?.[0];
					if (!choice) continue;

					const delta = choice.delta;

					// 内容
					if (delta?.content) {
						yield { type: "content", content: delta.content };
					}

					// 推理内容 (thinking)
					if (delta?.reasoning_content) {
						yield { type: "reasoning", content: delta.reasoning_content };
					}

					// 工具调用
					if (delta?.tool_calls) {
						for (const tc of delta.tool_calls) {
							if (tc.id) {
								// 新工具调用开始 — 保存前一个已完成的
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
								// 工具调用参数增量
								currentToolCall.function.arguments +=
									tc.function?.arguments || "";
							}
						}
					}

					// finish_reason 标记响应结束 — yield 所有已完成的工具调用
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

					// 使用量
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
	}

	/**
	 * 构建请求体 - 符合 MiMo OpenAI API 规范
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

		// 工具定义
		if (options.tools && options.tools.length > 0) {
			body.tools = options.tools.map((tool) => ({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description || "",
					parameters: tool.parameters || { type: "object", properties: {} },
				},
			}));
			body.tool_choice = "auto";
		}

		// 思考模式
		if (options.thinking || this.thinking) {
			body.thinking = options.thinking || this.thinking;
		}

		return body;
	}

	/**
	 * 格式化消息 - 处理 tool_calls 和 reasoning_content
	 */
	private formatMessages(messages: ChatMessage[]): any[] {
		return messages.map((msg) => {
			const formatted: any = {
				role: msg.role,
				content: msg.content,
			};

			// 工具调用
			if (msg.tool_calls) {
				formatted.tool_calls = msg.tool_calls;
			}

			// 工具结果
			if (msg.tool_call_id) {
				formatted.tool_call_id = msg.tool_call_id;
			}

			// 推理内容 (MiMo 特有)
			if (msg.reasoning_content) {
				formatted.reasoning_content = msg.reasoning_content;
			}

			return formatted;
		});
	}

	/**
	 * 解析响应
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
	 * 获取当前配置
	 */
	getConfig(): MiMoClientOptions {
		return {
			apiKey: "***",
			baseUrl: this.baseUrl,
			model: this.model,
			maxTokens: this.maxTokens,
			temperature: this.temperature,
			topP: this.topP,
			thinking: this.thinking,
		};
	}
}

/**
 * MiMo API 错误
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
