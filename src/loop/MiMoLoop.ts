import type { ApprovalRequest, ApprovalResponse } from "../approval/types.js";
import { CapacityController } from "../capacity/CapacityController.js";
import type { CapacityConfig, CapacitySnapshot } from "../capacity/types.js";
import type { StreamChunk } from "../clients/MiMoClient.js";
import type {
	ISingleAgentMemoryManager,
	MemoryInjectionResult,
} from "../memory/single/types.js";
import { StormBreaker } from "../repair/StormBreaker.js";
import type { ChatMessage, ToolCall, ToolDefinition } from "../types/common.js";
import type { ICompletenessChecker } from "../types/completeness.js";
import type { IContextManager, TaskState } from "../types/context.js";
import type { IToolCallRepair } from "../types/repair.js";
import type { ICodeValidator } from "../types/validator.js";
import { countMessagesTokens } from "../utils/token-counter.js";
import { healMessages } from "./healing.js";
import { buildAssistantMessage, buildSyntheticAssistantMessage } from "./messages.js";
import { ReadTracker, isEditTool, isReadTool } from "./ReadTracker.js";
import { SnapshotManager } from "./SnapshotManager.js";

/** Minimal interface for session persistence — avoids importing SessionManager directly. */
export interface ISessionPersister {
	persistFromLoop(messages: ChatMessage[], meta: {
		totalCostUsd?: number;
		totalTokens?: number;
		toolCalls?: number;
		steps?: number;
		model?: string;
	}): Promise<void>;
	flushSync(): void;
}

// ============ Constants ============

/** Max chars per tool result before truncation. */
const MAX_TOOL_RESULT_CHARS = 32_000;

/** Default max parallel tool calls for read-only batch. */
const DEFAULT_PARALLEL_MAX = 3;

/** Approximate MiMo API pricing (USD per 1 M tokens). */
const PRICE_INPUT_PER_M_USD = 0.4;
/** Cache-hit input tokens are billed at a steep discount (~0.1× fresh input). */
const PRICE_CACHED_PER_M_USD = 0.04;
const PRICE_OUTPUT_PER_M_USD = 1.6;

const MEMORY_PRELUDE_START = "<!-- mimo-memory-prelude:start -->";
const MEMORY_PRELUDE_END = "<!-- mimo-memory-prelude:end -->";

// ============ Minimal collaborator interfaces ============

export interface IStreamingClient {
	streamChat(options: {
		messages: ChatMessage[];
		tools?: ToolDefinition[];
		maxTokens?: number;
		thinking?: { type: "enabled" | "disabled"; budget_tokens?: number };
		signal?: AbortSignal;
	}): AsyncIterable<StreamChunk>;
}

export interface IToolHost {
	getDefinitions(): ToolDefinition[];
	execute(
		toolCall: { function: { name: string; arguments: string } },
		context?: { signal?: AbortSignal; workingDirectory?: string },
	): Promise<{ content: string; isError?: boolean }>;
}

export interface IHookManager {
	execute(
		event: string,
		context?: Record<string, unknown>,
	): Promise<Array<{ success: boolean; stdout?: string; stderr?: string }>>;
}

export interface IApprovalManager {
	requestApproval(
		tool: string,
		args: Record<string, any>,
		description: string,
	): Promise<ApprovalRequest>;
	checkApproval(request: ApprovalRequest): Promise<ApprovalResponse>;
}

// ============ Types ============

export interface MiMoLoopConfig {
	client: IStreamingClient;
	tools: IToolHost;
	validator?: ICodeValidator;
	toolRepair?: IToolCallRepair;
	completenessChecker?: ICompletenessChecker;
	contextManager?: IContextManager;
	memoryManager?: ISingleAgentMemoryManager;
	hookManager?: IHookManager;
	approvalManager?: IApprovalManager;
	capacity?: Partial<CapacityConfig>;
	storm?: { windowSize?: number; threshold?: number };
	enableReadGuard?: boolean;
	planMode?: boolean;
	onChunk?: (chunk: {
		type: "content" | "reasoning" | "tool_call";
		text?: string;
		name?: string;
	}) => void;
	maxTokens?: number;
	maxSteps?: number;
	budgetUsd?: number;
	workingDirectory: string;
	thinking?: {
		type: "enabled" | "disabled";
		budget_tokens?: number;
	};
	sessionPersister?: ISessionPersister;
}

export interface LoopState {
	running: boolean;
	currentStep: number;
	totalTokens: number;
	totalCostUsd: number;
	toolCalls: number;
	errors: number;
	startTime?: number;
}

export type LoopEvent =
	| { type: "content"; content: string }
	| { type: "reasoning"; content: string }
	| { type: "tool_call"; toolCall: ToolCall; repaired: boolean }
	| { type: "tool_result"; toolCall: ToolCall; result: any; success: boolean }
	| { type: "validation"; result: any }
	| { type: "completeness"; result: any }
	| { type: "context_optimized"; result: any }
	| { type: "iteration"; attempt: number; maxAttempts: number; error?: string }
	| { type: "usage"; usage: any }
	| { type: "capacity"; snapshot: CapacitySnapshot }
	| { type: "hook"; event: string; results: any[] }
	| { type: "plan_blocked"; toolCall: ToolCall }
	| { type: "error"; error: string; recoverable: boolean }
	| { type: "done"; success: boolean; result?: string }
	| { type: "steer_accepted"; content: string };

// ============ MiMoLoop ============

/**
 * MiMo 主循环 — 参考 DeepSeek-Reasonix 的 CacheFirstLoop
 *
 * 改进点（对标 Reasonix）：
 * 1. 消息 healing — 发送前修复 tool_call 配对、截断超大结果
 * 2. buildAssistantMessage — 正确构建含 tool_calls 的 assistant 消息
 * 3. 分块并行调度 — 只读工具分批并发，可配置 max
 * 4. 风暴自纠正 — 首次全抑制 → stub 响应让模型自纠正
 * 5. 强制摘要 — 上下文满或卡住时强制总结退出
 * 6. 正确的 steer 消息格式
 */
export class MiMoLoop {
	private config: MiMoLoopConfig;
	private state: LoopState;
	private messages: ChatMessage[] = [];
	private abortController: AbortController | null = null;
	private stormBreaker: StormBreaker;
	private capacity: CapacityController;
	private readTracker: ReadTracker;
	private snapshotManager: SnapshotManager;
	private steerQueue: string[] = [];
	/** True when a steer was consumed this turn (avoids double-submit). */
	private steerConsumed = false;
	private currentUserInput = "";
	private memoryWritebackDone = false;
	/** First all-suppressed storm → self-correct; second → force summary. */
	private selfCorrectedThisTurn = false;

	constructor(config: MiMoLoopConfig) {
		this.config = config;
		this.state = {
			running: false,
			currentStep: 0,
			totalTokens: 0,
			totalCostUsd: 0,
			toolCalls: 0,
			errors: 0,
		};
		this.stormBreaker = new StormBreaker(
			{
				windowSize: config.storm?.windowSize ?? 6,
				threshold: config.storm?.threshold ?? 3,
			},
			(call) => this.isMutatingTool(call),
			(call) => this.isStormExemptTool(call),
		);
		this.capacity = new CapacityController(config.capacity);
		this.readTracker = new ReadTracker();
		this.snapshotManager = new SnapshotManager();
	}

	/**
	 * 主执行循环 — 参考 Reasonix 的 step()
	 */
	async *run(userInput: string): AsyncGenerator<LoopEvent> {
		this.abortController = new AbortController();
		this.state.running = true;
		this.state.startTime = Date.now();
		this.stormBreaker.reset();
		this.readTracker.reset();
		this.snapshotManager.reset();
		this.selfCorrectedThisTurn = false;
		this.steerConsumed = false;
		this.currentUserInput = userInput;
		this.memoryWritebackDone = false;

		try {
			// 1. 添加用户消息
			this.messages.push({ role: "user", content: userInput });

			// UserPromptSubmit hook
			const submitHook = await this.runHooks("UserPromptSubmit", {
				userPrompt: userInput,
			});
			if (submitHook.results.length) {
				yield {
					type: "hook",
					event: "UserPromptSubmit",
					results: submitHook.results,
				};
			}

			// 2. 主循环（Reasonix 风格：无限迭代，通过 return 退出）
			const maxSteps = this.config.maxSteps || 50;

			for (let step = 0; step < maxSteps; step++) {
				// 检查取消
				if (this.abortController.signal.aborted) {
					this.messages.push(
						buildSyntheticAssistantMessage(
							"[aborted by user — no summary produced]",
						),
					);
					yield { type: "error", error: "Aborted by user", recoverable: false };
					break;
				}

				// 检查预算
				if (
					this.config.budgetUsd &&
					this.state.totalCostUsd >= this.config.budgetUsd
				) {
					yield { type: "error", error: "Budget exceeded", recoverable: false };
					break;
				}

				this.state.currentStep = step + 1;

				// 处理 steer 队列（每次迭代最多消费一个，参考 Reasonix）
				if (this.steerQueue.length > 0) {
					const steer = this.steerQueue.shift()!;
					this.steerConsumed = this.steerQueue.length === 0;
					this.messages.push({
						role: "user",
						content: `[Mid-turn steer] ${steer}`,
					});
					yield { type: "steer_accepted", content: steer };
				}

				// 上下文优化
				if (this.config.contextManager) {
					const optimized = await this.optimizeContext();
					if (optimized) {
						yield { type: "context_optimized", result: optimized };
					}
				}

				// 容量检查点
				if (this.capacity.isEnabled()) {
					const snapshot = this.capacity.observe({
						turnIndex: step,
						promptTokens: countMessagesTokens(this.messages),
						maxTokens: this.config.maxTokens || 131072,
						toolCalls: this.state.toolCalls,
					});
					yield { type: "capacity", snapshot };
					await this.applyCapacityAction(snapshot, step);
				}

				await this.refreshMemoryPrelude();

				// Healing：发送前修复消息（截断超大结果、修复配对）
				const healed = healMessages(this.messages, MAX_TOOL_RESULT_CHARS);
				if (healed.healedCount > 0) {
					this.messages = healed.messages;
				}

				// 调用模型
				let response;
				try {
					response = await this.callModel(this.abortController?.signal);
				} catch (error: any) {
					this.state.errors++;
					yield { type: "error", error: error.message, recoverable: true };
					continue;
				}

				// 推理内容
				if (response.reasoningContent) {
					yield { type: "reasoning", content: response.reasoningContent };
				}

				// 文本内容
				if (response.content) {
					yield { type: "content", content: response.content };
				}

				// 推入 assistant 消息（使用 buildAssistantMessage 确保结构正确）
				if (response.content || response.toolCalls) {
					this.messages.push(
						buildAssistantMessage(
							response.content || "",
							response.toolCalls || [],
							response.reasoningContent,
						),
					);
				}

				// 处理工具调用
				if (response.toolCalls && response.toolCalls.length > 0) {
					const { calls: repairedCalls, report } = this.repairToolCalls(
						response.toolCalls,
					);

					// 风暴检测 + 自纠正（参考 Reasonix）
					const stormResult = this.stormBreaker.inspectBatch(repairedCalls);
					const suppressedCalls = stormResult.suppressed;
					const activeCalls = repairedCalls.filter(
						(_, i) => !suppressedCalls[i],
					);

					// 全部被抑制的风暴处理
					if (activeCalls.length === 0 && repairedCalls.length > 0) {
						if (!this.selfCorrectedThisTurn) {
							// 第一次：stub 响应，让模型自纠正
							this.selfCorrectedThisTurn = true;
							for (const call of repairedCalls) {
								this.messages.push({
									role: "tool",
									content:
										"[repeat-loop guard] this call was suppressed because it was identical to a previous call. Try a different approach, or stop and answer.",
									tool_call_id: call.id,
								});
								yield {
									type: "tool_result",
									toolCall: call,
									result: {
										content: "suppressed by storm breaker",
										isError: true,
									},
									success: false,
								};
							}
							yield {
								type: "error",
								error: "Storm detected — all tool calls suppressed, letting model self-correct",
								recoverable: true,
							};
							continue;
						}
						// 第二次：强制摘要退出（参考 Reasonix forceSummaryAfterIterLimit）
						yield* this.forceSummary("stuck");
						yield* this.finishTurn();
						return;
					}

					// 全部为只读工具时，并行执行（提速，参考 DEFAULT_PARALLEL_MAX）
					if (activeCalls.length > 1 && activeCalls.every((tc) => isReadTool(tc))) {
						yield* this.executeReadBatch(activeCalls);
						continue;
					}

					// 逐个执行活跃的工具调用
					for (const toolCall of activeCalls) {
						yield {
							type: "tool_call",
							toolCall,
							repaired:
								report.scavenged > 0 || report.truncationsFixed > 0,
						};

						// 先读后写守卫
						if (this.config.enableReadGuard !== false && isEditTool(toolCall)) {
							const editArgs = this.safeParseArgs(toolCall);
							const blockReason = this.readTracker.guardEdit(
								editArgs.path,
								this.config.workingDirectory,
							);
							if (blockReason) {
								yield {
									type: "tool_result",
									toolCall,
									result: { content: blockReason, isError: true },
									success: false,
								};
								this.messages.push({
									role: "tool",
									content: blockReason,
									tool_call_id: toolCall.id,
								});
								continue;
							}
						}

						// Plan mode 拦截
						if (this.config.planMode && this.isMutatingTool(toolCall)) {
							const reason = `Plan mode is read-only — ${toolCall.function.name} is blocked.`;
							yield { type: "plan_blocked", toolCall };
							yield {
								type: "tool_result",
								toolCall,
								result: { content: reason, isError: true },
								success: false,
							};
							this.messages.push({
								role: "tool",
								content: reason,
								tool_call_id: toolCall.id,
							});
							continue;
						}

						// PreToolUse hook
						const preHook = await this.runHooks("PreToolUse", {
							toolName: toolCall.function.name,
							toolArgs: this.safeParseArgs(toolCall),
						});
						if (preHook.results.length) {
							yield {
								type: "hook",
								event: "PreToolUse",
								results: preHook.results,
							};
						}
						if (preHook.block) {
							const reason = `Blocked by PreToolUse hook: ${preHook.reason || "non-zero exit"}`;
							yield {
								type: "tool_result",
								toolCall,
								result: { content: reason, isError: true },
								success: false,
							};
							this.messages.push({
								role: "tool",
								content: reason,
								tool_call_id: toolCall.id,
							});
							continue;
						}

						// 审批检查
						if (this.config.approvalManager) {
							const request =
								await this.config.approvalManager.requestApproval(
									toolCall.function.name,
									this.safeParseArgs(toolCall),
									`Execute ${toolCall.function.name}`,
								);
							const approval =
								await this.config.approvalManager.checkApproval(request);
							if (!approval.approved) {
								yield {
									type: "tool_result",
									toolCall,
									result: {
										content: `Rejected: ${approval.reason}`,
										isError: true,
									},
									success: false,
								};
								this.messages.push({
									role: "tool",
									content: `Rejected: ${approval.reason}`,
									tool_call_id: toolCall.id,
								});
								continue;
							}
						}

						// 预快照
						const editArgs = isEditTool(toolCall)
							? this.safeParseArgs(toolCall)
							: null;
						if (editArgs?.path) {
							await this.snapshotManager.snapshot(
								editArgs.path,
								this.config.workingDirectory,
							);
						}

						// 执行工具
						this.state.toolCalls++;
						const result = await this.executeToolWithRetry(toolCall);

						// PostToolUse hook
						const postHook = await this.runHooks("PostToolUse", {
							toolName: toolCall.function.name,
							toolArgs: this.safeParseArgs(toolCall),
							toolResult: result,
						});
						if (postHook.results.length) {
							yield {
								type: "hook",
								event: "PostToolUse",
								results: postHook.results,
							};
						}

						// 记录已读文件
						if (isReadTool(toolCall) && !result.isError) {
							const readArgs = this.safeParseArgs(toolCall);
							this.readTracker.markRead(
								readArgs.path,
								this.config.workingDirectory,
							);
						}

						// 验证结果
						let finalResult = result;
						if (this.config.validator && !result.isError) {
							const toolArgs = this.safeParseArgs(toolCall);
							const validation = await this.config.validator.validate({
								toolName: toolCall.function.name,
								toolArgs,
								toolResult: result,
								filePath: toolArgs.path,
								workingDirectory: this.config.workingDirectory,
							});
							if (!validation.passed) {
								yield { type: "validation", result: validation };
								if (editArgs?.path) {
									const restored = await this.snapshotManager.restore(
										editArgs.path,
										this.config.workingDirectory,
									);
									const diagLines = (validation.checks as any[])
										.filter((c: any) => !c.passed)
										.map(
											(c: any) =>
												`  ${c.location ? `${c.location.file}(${c.location.line},${c.location.column}): ` : ""}${c.message}`,
										)
										.join("\n");
									finalResult = {
										content: [
											result.content,
											"",
											`Validation failed with ${(validation.checks as any[]).filter((c: any) => !c.passed).length} issue(s):`,
											diagLines,
											restored
												? "\nFile has been restored to its pre-edit state."
												: "",
										]
											.join("\n")
											.trim(),
										isError: true,
									};
								}
							}
						}

						yield {
							type: "tool_result",
							toolCall,
							result: finalResult,
							success: !finalResult.isError,
						};
						this.messages.push({
							role: "tool",
							content: finalResult.content,
							tool_call_id: toolCall.id,
						});
					}

					// 继续循环
					continue;
				}

				// 没有工具调用 — 完成
				yield* this.finishTurn();
				yield {
					type: "done",
					success: true,
					result: response.content,
				};
				return;
			}

			// 达到 maxSteps — 强制摘要
			yield* this.forceSummary("stuck");
			yield* this.finishTurn();
		} catch (error: any) {
			this.state.errors++;
			yield { type: "error", error: error.message, recoverable: false };
		} finally {
			this.state.running = false;
			await this.writebackMemory();
			this.config.sessionPersister?.persistFromLoop(
				this.getMessagesWithoutMemoryPrelude(),
				{
					totalCostUsd: this.state.totalCostUsd,
					totalTokens: this.state.totalTokens,
					toolCalls: this.state.toolCalls,
					steps: this.state.currentStep,
				},
			).catch(() => {});
		}
	}

	/**
	 * 强制摘要退出 — 参考 Reasonix 的 forceSummaryAfterIterLimit
	 * 当上下文满或模型卡住时，注入摘要指令让模型总结后退出。
	 */
	private async *forceSummary(
		reason: "context-guard" | "stuck",
	): AsyncGenerator<LoopEvent> {
		yield {
			type: "content",
			content: `[${reason}] Forcing summary — the model will summarize what was accomplished.`,
		};
		this.messages.push({
			role: "user",
			content:
				"The turn is being force-summarized. Summarize in plain text what you learned from the tool results above. Do NOT emit any tool calls — just plain text.",
		});

		try {
			await this.refreshMemoryPrelude();
			const response = await this.callModel(this.abortController?.signal);
			const summary = response.content || "No summary produced.";
			this.messages.push(buildAssistantMessage(summary, [], response.reasoningContent));
			yield { type: "content", content: summary };
			yield { type: "done", success: true, result: summary };
		} catch (error: any) {
			yield {
				type: "error",
				error: `Force summary failed: ${error.message}`,
				recoverable: false,
			};
			yield { type: "done", success: false };
		}
	}

	/**
	 * 调用模型 - 流式
	 */
	private async callModel(signal?: AbortSignal): Promise<{
		content: string;
		reasoningContent?: string;
		toolCalls?: ToolCall[];
		usage?: any;
	}> {
		const messages = this.messages;
		let content = "";
		let reasoningContent = "";
		const toolCalls: ToolCall[] = [];
		let usage: any = null;

		for await (const chunk of this.config.client.streamChat({
			messages,
			tools: this.config.tools.getDefinitions(),
			maxTokens: this.config.maxTokens,
			thinking: this.config.thinking,
			signal,
		})) {
			switch (chunk.type) {
				case "content":
					content += chunk.content;
					this.config.onChunk?.({ type: "content", text: chunk.content });
					break;
				case "reasoning":
					reasoningContent += chunk.content;
					this.config.onChunk?.({ type: "reasoning", text: chunk.content });
					break;
				case "tool_call":
					if (chunk.toolCall) {
						toolCalls.push(chunk.toolCall);
						this.config.onChunk?.({
							type: "tool_call",
							name: chunk.toolCall.function.name,
						});
					}
					break;
				case "usage":
					usage = chunk.usage;
					if (usage) {
						this.state.totalTokens += usage.totalTokens || 0;
						// 三段计价：fresh input / cache-hit input / output
						const cachedTokens = usage.cachedTokens || 0;
						const freshInput = (usage.promptTokens || 0) - cachedTokens;
						const outputTokens = usage.completionTokens || 0;
						this.state.totalCostUsd +=
							(freshInput * PRICE_INPUT_PER_M_USD +
								cachedTokens * PRICE_CACHED_PER_M_USD +
								outputTokens * PRICE_OUTPUT_PER_M_USD) /
							1_000_000;
					}
					break;
				case "error":
					throw new Error(chunk.error);
			}
		}

		return {
			content,
			reasoningContent: reasoningContent || undefined,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			usage,
		};
	}

	/**
	 * End-of-turn cleanup: Stop hook + usage stats.
	 * Called before every done/return exit point.
	 */
	private async *finishTurn(): AsyncGenerator<LoopEvent> {
		const stopHook = await this.runHooks("Stop", {});
		if (stopHook.results.length) {
			yield { type: "hook", event: "Stop", results: stopHook.results };
		}
		yield {
			type: "usage",
			usage: {
				totalTokens: this.state.totalTokens,
				totalCostUsd: this.state.totalCostUsd,
				toolCalls: this.state.toolCalls,
				steps: this.state.currentStep,
			},
		};
	}

	private async applyCapacityAction(
		snapshot: CapacitySnapshot,
		step: number,
	): Promise<void> {
		if (snapshot.action === "targeted_refresh") {
			if (this.config.contextManager) {
				await this.optimizeContext();
			}
			this.capacity.recordRefresh(step);
		} else if (snapshot.action === "verify_and_replan") {
			this.steerQueue.push(
				"[Capacity guard] Context is nearly full. Finish any partially-implemented work before starting new subtasks.",
			);
			this.capacity.recordRefresh(step);
		}
	}

	private isMemoryPreludeMessage(message: ChatMessage): boolean {
		return (
			message.role === "system" &&
			typeof message.content === "string" &&
			message.content.includes(MEMORY_PRELUDE_START)
		);
	}

	private getMessagesWithoutMemoryPrelude(): ChatMessage[] {
		return this.messages.filter((message) => !this.isMemoryPreludeMessage(message));
	}

	private async refreshMemoryPrelude(): Promise<void> {
		const memoryManager = this.config.memoryManager;
		if (!memoryManager) return;

		let result: MemoryInjectionResult;
		try {
			result = await memoryManager.buildPrelude({
				messages: this.getMessagesWithoutMemoryPrelude(),
				workingDirectory: this.config.workingDirectory,
				userInput: this.currentUserInput,
				turnIndex: this.state.currentStep,
				maxTokens: this.config.maxTokens,
				signal: this.abortController?.signal,
			});
		} catch {
			return;
		}

		const existingIndex = this.messages.findIndex((message) =>
			this.isMemoryPreludeMessage(message),
		);
		const prelude = result.prelude.trim();

		if (!prelude) {
			if (existingIndex >= 0) this.messages.splice(existingIndex, 1);
			return;
		}

		const content = [MEMORY_PRELUDE_START, prelude, MEMORY_PRELUDE_END].join("\n");
		if (existingIndex >= 0) {
			this.messages[existingIndex] = { ...this.messages[existingIndex]!, content };
			return;
		}

		let insertAt = 0;
		while (this.messages[insertAt]?.role === "system") insertAt++;
		this.messages.splice(insertAt, 0, { role: "system", content });
	}

	private async writebackMemory(): Promise<void> {
		const memoryManager = this.config.memoryManager;
		if (!memoryManager || this.memoryWritebackDone) return;
		this.memoryWritebackDone = true;

		try {
			await memoryManager.writeback({
				messages: this.getMessagesWithoutMemoryPrelude(),
				workingDirectory: this.config.workingDirectory,
				userInput: this.currentUserInput,
				turnIndex: this.state.currentStep,
				totalCostUsd: this.state.totalCostUsd,
				totalTokens: this.state.totalTokens,
				toolCalls: this.state.toolCalls,
				steps: this.state.currentStep,
				signal: this.abortController?.signal,
			});
		} catch {
			// Memory writeback is best-effort and must not change loop semantics.
		}
	}

	private async runHooks(
		event: "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop",
		ctx: {
			toolName?: string;
			toolArgs?: Record<string, any>;
			toolResult?: any;
			userPrompt?: string;
		},
	): Promise<{ block: boolean; reason?: string; results: any[] }> {
		if (!this.config.hookManager) return { block: false, results: [] };
		try {
			const results = await this.config.hookManager.execute(event, {
				workingDirectory: this.config.workingDirectory,
				...ctx,
			});
			const failed = (results as any[]).find((r) => r.success === false);
			return {
				block: event === "PreToolUse" && !!failed,
				reason: failed?.stderr,
				results: results || [],
			};
		} catch {
			return { block: false, results: [] };
		}
	}

	private safeParseArgs(toolCall: ToolCall): Record<string, any> {
		try {
			return JSON.parse(toolCall.function.arguments || "{}");
		} catch {
			return {};
		}
	}

	private async optimizeContext(): Promise<any> {
		if (!this.config.contextManager) return null;
		const messages = this.getMessagesWithoutMemoryPrelude();
		const taskState: TaskState = {
			objective: messages[0]?.content || "",
			currentStep: this.state.currentStep,
			completedSubtasks: [],
			pendingSubtasks: [],
		};
		const result = await this.config.contextManager.optimize({
			messages,
			taskState,
			maxTokens: this.config.maxTokens || 131072,
		});
		if (result.folded) {
			this.messages = result.messages;
		}
		return result;
	}

	private repairToolCalls(toolCalls: ToolCall[]): {
		calls: ToolCall[];
		report: {
			scavenged: number;
			truncationsFixed: number;
			stormsBroken: number;
			notes: string[];
		};
	} {
		if (!this.config.toolRepair) {
			return {
				calls: toolCalls,
				report: {
					scavenged: 0,
					truncationsFixed: 0,
					stormsBroken: 0,
					notes: [],
				},
			};
		}
		const report = {
			scavenged: 0,
			truncationsFixed: 0,
			stormsBroken: 0,
			notes: [] as string[],
		};
		const repaired: ToolCall[] = [];
		for (const tc of toolCalls) {
			try {
				JSON.parse(tc.function.arguments);
				repaired.push(tc);
			} catch {
				const fixed = this.repairJson(tc.function.arguments);
				if (fixed.changed) {
					repaired.push({
						...tc,
						function: { ...tc.function, arguments: fixed.repaired },
					});
					report.truncationsFixed++;
					report.notes.push(
						`Fixed truncated JSON for ${tc.function?.name || "unknown"}`,
					);
				} else {
					repaired.push(tc);
				}
			}
		}
		return { calls: repaired, report };
	}

	private repairJson(jsonStr: string): { repaired: string; changed: boolean } {
		try {
			JSON.parse(jsonStr);
			return { repaired: jsonStr, changed: false };
		} catch {
			// try to repair
		}
		const stack: string[] = [];
		let inString = false;
		let escaped = false;
		let lastSignificant = -1;
		for (let i = 0; i < jsonStr.length; i++) {
			const c = jsonStr[i] || "";
			if (!/\s/.test(c)) lastSignificant = i;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (c === "\\") {
				escaped = true;
				continue;
			}
			if (c === '"') {
				inString = !inString;
				continue;
			}
			if (inString) continue;
			if (c === "{" || c === "[") stack.push(c);
			if (c === "}" || c === "]") stack.pop();
		}
		let s = jsonStr.slice(0, lastSignificant + 1);
		if (/,$/.test(s)) s = s.replace(/,$/, "");
		if (/"\s*:\s*$/.test(s)) s += " null";
		if (inString) {
			s += '"';
			stack.pop();
		}
		while (stack.length > 0) {
			const top = stack.pop();
			if (top === "{") s += "}";
			else if (top === "[") s += "]";
		}
		try {
			JSON.parse(s);
			return { repaired: s, changed: true };
		} catch {
			return { repaired: "{}", changed: true };
		}
	}

	private async executeTool(
		toolCall: ToolCall,
	): Promise<{ content: string; isError?: boolean }> {
		try {
			return await this.config.tools.execute(toolCall, {
				signal: this.abortController?.signal,
				workingDirectory: this.config.workingDirectory,
			});
		} catch (error: any) {
			return {
				content: `工具 "${toolCall.function.name}" 执行失败: ${error.message}`,
				isError: true,
			};
		}
	}

	private async executeToolWithRetry(
		toolCall: ToolCall,
	): Promise<{ content: string; isError?: boolean }> {
		const TRANSIENT =
			/timeout|ETIMEDOUT|EBUSY|EAGAIN|ECONNRESET|ENFILE|EMFILE/i;
		let last: { content: string; isError?: boolean } = {
			content: "",
			isError: true,
		};
		for (let attempt = 0; attempt <= 2; attempt++) {
			const result = await this.executeTool(toolCall);
			if (!result.isError || !TRANSIENT.test(result.content)) return result;
			last = result;
			if (attempt < 2) {
				await new Promise<void>((r) => setTimeout(r, 300 * (attempt + 1)));
			}
		}
		return { ...last, content: `[重试 2 次后仍失败] ${last.content}` };
	}

	/**
	 * 并行执行一批只读工具（无审批、无写操作），结果按原顺序 yield。
	 * 并发度上限 DEFAULT_PARALLEL_MAX。
	 */
	private async *executeReadBatch(toolCalls: ToolCall[]): AsyncGenerator<LoopEvent> {
		// Emit all tool_call events first so the UI can show them immediately
		for (const tc of toolCalls) {
			yield { type: "tool_call", toolCall: tc, repaired: false };
		}

		// Pre-hooks (sequential, fast)
		const blocked = new Map<string, string>();
		if (this.config.hookManager) {
			for (const tc of toolCalls) {
				const pre = await this.runHooks("PreToolUse", {
					toolName: tc.function.name,
					toolArgs: this.safeParseArgs(tc),
				});
				if (pre.block) blocked.set(tc.id ?? "", `Blocked by PreToolUse: ${pre.reason}`);
			}
		}

		// Parallel execution in batches of DEFAULT_PARALLEL_MAX
		const results = new Map<string, { content: string; isError?: boolean }>();
		const toRun = toolCalls.filter((tc) => !blocked.has(tc.id ?? ""));
		for (let i = 0; i < toRun.length; i += DEFAULT_PARALLEL_MAX) {
			const batch = toRun.slice(i, i + DEFAULT_PARALLEL_MAX);
			const settled = await Promise.allSettled(batch.map((tc) => this.executeToolWithRetry(tc)));
			for (let j = 0; j < batch.length; j++) {
				const s = settled[j]!;
				results.set(
					batch[j]!.id ?? "",
					s.status === "fulfilled" ? s.value : { content: String(s.reason), isError: true },
				);
			}
		}

		// Yield results in original order, update read tracker and messages
		for (const tc of toolCalls) {
			const tcId = tc.id ?? "";
			const result = blocked.has(tcId)
				? { content: blocked.get(tcId)!, isError: true }
				: (results.get(tcId) ?? { content: "not executed", isError: true });

			// Post-hook
			if (this.config.hookManager) {
				const post = await this.runHooks("PostToolUse", {
					toolName: tc.function.name,
					toolArgs: this.safeParseArgs(tc),
					toolResult: result,
				});
				if (post.results.length) {
					yield { type: "hook", event: "PostToolUse", results: post.results };
				}
			}

			if (!result.isError) {
				const args = this.safeParseArgs(tc);
				this.readTracker.markRead(args.path, this.config.workingDirectory);
			}

			yield { type: "tool_result", toolCall: tc, result, success: !result.isError };
			this.messages.push({ role: "tool", content: result.content, tool_call_id: tcId });
		}
	}

	private isMutatingTool(call: ToolCall): boolean {
		const mutatingTools = [
			"write_file",
			"edit_file",
			"apply_patch",
			"exec_shell",
			"git_commit",
			"git_push",
		];
		return mutatingTools.includes(call.function.name);
	}

	private isStormExemptTool(call: ToolCall): boolean {
		const exemptTools = [
			"read_file",
			"list_directory",
			"git_status",
			"git_diff",
		];
		return exemptTools.includes(call.function.name);
	}

	steer(text: string): void {
		this.steerQueue.push(text);
		this.steerConsumed = false;
	}

	abort(): void {
		this.abortController?.abort();
	}

	getState(): LoopState {
		return { ...this.state };
	}

	getMessages(): ChatMessage[] {
		return [...this.messages];
	}

	addSystemMessage(content: string): void {
		this.messages.unshift({ role: "system", content });
	}

	configure(config: Partial<MiMoLoopConfig>): void {
		this.config = { ...this.config, ...config };
	}
}
