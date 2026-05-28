import type { ChatMessage, ToolCall, ToolDefinition } from '../types/common.js';
import type { StreamChunk } from '../clients/MiMoClient.js';
import type { ICodeValidator } from '../types/validator.js';
import type { IToolCallRepair } from '../types/repair.js';
import type { ICompletenessChecker } from '../types/completeness.js';
import type { IContextManager, TaskState } from '../types/context.js';
import type { ApprovalRequest, ApprovalResponse } from '../approval/types.js';
import { StormBreaker } from '../repair/StormBreaker.js';
import { CapacityController } from '../capacity/CapacityController.js';
import type { CapacityConfig, CapacitySnapshot } from '../capacity/types.js';
import { ReadTracker, isReadTool, isEditTool } from './ReadTracker.js';
import { SnapshotManager } from './SnapshotManager.js';
import { countMessagesTokens } from '../utils/token-counter.js';

// ============ Minimal collaborator interfaces ============

/** Anything that can stream model chunks — satisfied by MiMoClient. */
export interface IStreamingClient {
  streamChat(options: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    maxTokens?: number;
    thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number };
  }): AsyncIterable<StreamChunk>;
}

/** Anything that exposes tool definitions and executes calls — satisfied by ToolRegistry. */
export interface IToolHost {
  getDefinitions(): ToolDefinition[];
  execute(
    toolCall: { function: { name: string; arguments: string } },
    context?: { signal?: AbortSignal; workingDirectory?: string },
  ): Promise<{ content: string; isError?: boolean }>;
}

/** Minimal hook manager contract — satisfied by HookManager and inline test doubles. */
export interface IHookManager {
  execute(
    event: string,
    context?: Record<string, unknown>,
  ): Promise<Array<{ success: boolean; stdout?: string; stderr?: string }>>;
}

/** Minimal approval manager contract — satisfied by ApprovalManager. */
export interface IApprovalManager {
  requestApproval(tool: string, args: Record<string, any>, description: string): Promise<ApprovalRequest>;
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
  hookManager?: IHookManager;
  approvalManager?: IApprovalManager;
  capacity?: Partial<CapacityConfig>;
  storm?: { windowSize?: number; threshold?: number };
  enableReadGuard?: boolean;
  planMode?: boolean;
  /** Streaming callback — fired per chunk during callModel() for real-time TUI updates. */
  onChunk?: (chunk: { type: 'content' | 'reasoning' | 'tool_call'; text?: string; name?: string }) => void;
  maxTokens?: number;
  maxSteps?: number;
  budgetUsd?: number;
  workingDirectory: string;
  thinking?: {
    type: 'enabled' | 'disabled';
    budget_tokens?: number;
  };
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
  | { type: 'content'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall; repaired: boolean }
  | { type: 'tool_result'; toolCall: ToolCall; result: any; success: boolean }
  | { type: 'validation'; result: any }
  | { type: 'completeness'; result: any }
  | { type: 'context_optimized'; result: any }
  | { type: 'iteration'; attempt: number; maxAttempts: number; error?: string }
  | { type: 'usage'; usage: any }
  | { type: 'capacity'; snapshot: CapacitySnapshot }
  | { type: 'hook'; event: string; results: any[] }
  | { type: 'plan_blocked'; toolCall: ToolCall }
  | { type: 'error'; error: string; recoverable: boolean }
  | { type: 'done'; success: boolean; result?: string }
  | { type: 'steer_accepted'; content: string };

// ============ MiMoLoop ============

/**
 * MiMo 主循环 - 参考 DeepSeek-Reasonix 的 CacheFirstLoop 和 CodeWhale 的 turn_loop
 * 
 * 设计原则：
 * 1. 流式优先 - 所有响应都是流式的
 * 2. 工具调用修复 - 4阶段修复管道
 * 3. 上下文感知 - 智能折叠和压缩
 * 4. 审批控制 - 危险操作需要确认
 * 5. 风暴检测 - 防止重复调用
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

  constructor(config: MiMoLoopConfig) {
    this.config = config;
    this.state = {
      running: false,
      currentStep: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      toolCalls: 0,
      errors: 0
    };
    this.stormBreaker = new StormBreaker(
      {
        windowSize: config.storm?.windowSize ?? 6,
        threshold: config.storm?.threshold ?? 3,
      },
      (call) => this.isMutatingTool(call),
      (call) => this.isStormExemptTool(call)
    );
    this.capacity = new CapacityController(config.capacity);
    this.readTracker = new ReadTracker();
    this.snapshotManager = new SnapshotManager();
  }

  /**
   * 主执行循环 - 参考 DeepSeek-Reasonix 的 step() 和 CodeWhale 的 handle_deepseek_turn()
   */
  async *run(userInput: string): AsyncGenerator<LoopEvent> {
    this.abortController = new AbortController();
    this.state.running = true;
    this.state.startTime = Date.now();
    this.stormBreaker.reset();
    this.readTracker.reset();
    this.snapshotManager.reset();

    try {
      // 1. 添加用户消息
      this.messages.push({ role: 'user', content: userInput });

      // P0-2 UserPromptSubmit hook
      const submitHook = await this.runHooks('UserPromptSubmit', { userPrompt: userInput });
      if (submitHook.results.length) {
        yield { type: 'hook', event: 'UserPromptSubmit', results: submitHook.results };
      }

      // 2. 主循环
      const maxSteps = this.config.maxSteps || 50;

      for (let step = 0; step < maxSteps; step++) {
        // 检查取消
        if (this.abortController.signal.aborted) {
          yield { type: 'error', error: 'Aborted by user', recoverable: false };
          break;
        }

        // 处理 steer 队列
        while (this.steerQueue.length > 0) {
          const steer = this.steerQueue.shift()!;
          this.messages.push({
            role: 'user',
            content: `[Mid-turn steer] ${steer}`
          });
          yield { type: 'steer_accepted', content: steer };
        }

        // 检查预算
        if (this.config.budgetUsd && this.state.totalCostUsd >= this.config.budgetUsd) {
          yield { type: 'error', error: 'Budget exceeded', recoverable: false };
          break;
        }

        this.state.currentStep = step + 1;

        // 3. 上下文优化
        if (this.config.contextManager) {
          const optimized = await this.optimizeContext();
          if (optimized) {
            yield { type: 'context_optimized', result: optimized };
          }
        }

        // 3.5 容量检查点 - 参考 CodeWhale 的 capacity checkpoint
        if (this.capacity.isEnabled()) {
          const snapshot = this.capacity.observe({
            turnIndex: step,
            promptTokens: countMessagesTokens(this.messages),
            maxTokens: this.config.maxTokens || 131072,
            toolCalls: this.state.toolCalls
          });
          yield { type: 'capacity', snapshot };
          await this.applyCapacityAction(snapshot, step);
        }

        // 4. 调用模型
        let response;
        try {
          response = await this.callModel();
        } catch (error: any) {
          this.state.errors++;
          yield { type: 'error', error: error.message, recoverable: true };
          continue;
        }

        // 5. 处理推理内容
        if (response.reasoningContent) {
          yield { type: 'reasoning', content: response.reasoningContent };
        }

        // 6. 处理文本内容
        if (response.content) {
          yield { type: 'content', content: response.content };
          this.messages.push({
            role: 'assistant',
            content: response.content,
            reasoning_content: response.reasoningContent
          });
        }

        // 7. 处理工具调用
        if (response.toolCalls && response.toolCalls.length > 0) {
          // 工具调用修复
          const { calls: repairedCalls, report } = this.repairToolCalls(response.toolCalls);

          // 并行快速路径：全部为只读工具时并发执行（对标 Claude Code parallel tool calls）
          if (repairedCalls.length > 1 && repairedCalls.every(tc => isReadTool(tc))) {
            this.state.toolCalls += repairedCalls.length;
            yield* this.executeReadBatch(repairedCalls);
            continue;
          }

          for (const toolCall of repairedCalls) {
            // 风暴检测
            const stormResult = this.stormBreaker.inspect(toolCall);
            if (stormResult.suppress) {
              yield {
                type: 'tool_result',
                toolCall,
                result: { content: stormResult.reason, isError: true },
                success: false
              };
              continue;
            }

            yield {
              type: 'tool_call',
              toolCall,
              repaired: report.scavenged > 0 || report.truncationsFixed > 0
            };

            // 先读后写守卫 - 防止 MiMo 盲改文件 (Code Defect)
            if (this.config.enableReadGuard !== false && isEditTool(toolCall)) {
              const editArgs = this.safeParseArgs(toolCall);
              const blockReason = this.readTracker.guardEdit(
                editArgs.path,
                this.config.workingDirectory
              );
              if (blockReason) {
                yield {
                  type: 'tool_result',
                  toolCall,
                  result: { content: blockReason, isError: true },
                  success: false
                };
                this.messages.push({
                  role: 'tool',
                  content: blockReason,
                  tool_call_id: toolCall.id
                });
                continue;
              }
            }

            // P0-3 Plan mode：只读模式下拦截一切变异工具
            if (this.config.planMode && this.isMutatingTool(toolCall)) {
              const reason = `Plan mode is read-only — ${toolCall.function.name} is blocked. Present the plan; switch off plan mode to execute.`;
              yield { type: 'plan_blocked', toolCall };
              yield {
                type: 'tool_result',
                toolCall,
                result: { content: reason, isError: true },
                success: false
              };
              this.messages.push({ role: 'tool', content: reason, tool_call_id: toolCall.id });
              continue;
            }

            // P0-2 PreToolUse hook（非零退出可阻断工具）
            const preHook = await this.runHooks('PreToolUse', {
              toolName: toolCall.function.name,
              toolArgs: this.safeParseArgs(toolCall)
            });
            if (preHook.results.length) {
              yield { type: 'hook', event: 'PreToolUse', results: preHook.results };
            }
            if (preHook.block) {
              const reason = `Blocked by PreToolUse hook: ${preHook.reason || 'non-zero exit'}`;
              yield {
                type: 'tool_result',
                toolCall,
                result: { content: reason, isError: true },
                success: false
              };
              this.messages.push({ role: 'tool', content: reason, tool_call_id: toolCall.id });
              continue;
            }

            // 审批检查
            if (this.config.approvalManager) {
              const request = await this.config.approvalManager.requestApproval(
                toolCall.function.name,
                JSON.parse(toolCall.function.arguments || '{}'),
                `Execute ${toolCall.function.name}`
              );
              
              const approval = await this.config.approvalManager.checkApproval(request);
              if (!approval.approved) {
                yield {
                  type: 'tool_result',
                  toolCall,
                  result: { content: `Rejected: ${approval.reason}`, isError: true },
                  success: false
                };
                this.messages.push({
                  role: 'tool',
                  content: `Rejected: ${approval.reason}`,
                  tool_call_id: toolCall.id
                });
                continue;
              }
            }

            // P1-2 预快照：edit/write 工具执行前保存原始文件内容
            const editArgs = isEditTool(toolCall) ? this.safeParseArgs(toolCall) : null;
            if (editArgs?.path) {
              await this.snapshotManager.snapshot(
                editArgs.path,
                this.config.workingDirectory
              );
            }

            // 执行工具（含瞬时错误重试）
            this.state.toolCalls++;
            const result = await this.executeToolWithRetry(toolCall);

            // P0-2 PostToolUse hook
            const postHook = await this.runHooks('PostToolUse', {
              toolName: toolCall.function.name,
              toolArgs: this.safeParseArgs(toolCall),
              toolResult: result
            });
            if (postHook.results.length) {
              yield { type: 'hook', event: 'PostToolUse', results: postHook.results };
            }

            // 记录已读文件 - 供先读后写守卫使用
            if (isReadTool(toolCall) && !result.isError) {
              const readArgs = this.safeParseArgs(toolCall);
              this.readTracker.markRead(readArgs.path, this.config.workingDirectory);
            }

            // P1-1 + P1-2 验证结果，失败时回滚文件并丰富反馈
            let finalResult = result;
            if (this.config.validator && !result.isError) {
              const toolArgs = this.safeParseArgs(toolCall);
              const validation = await this.config.validator.validate({
                toolName: toolCall.function.name,
                toolArgs,
                toolResult: result,
                filePath: toolArgs.path,
                workingDirectory: this.config.workingDirectory
              });

              if (!validation.passed) {
                yield { type: 'validation', result: validation };

                // P1-2 回滚文件到编辑前状态，防止脏状态叠加
                if (editArgs?.path) {
                  const restored = await this.snapshotManager.restore(
                    editArgs.path,
                    this.config.workingDirectory
                  );
                  const diagLines = (validation.checks as any[])
                    .filter((c: any) => !c.passed)
                    .map((c: any) => `  ${c.location ? `${c.location.file}(${c.location.line},${c.location.column}): ` : ''}${c.message}`)
                    .join('\n');
                  finalResult = {
                    content: [
                      result.content,
                      '',
                      `Validation failed with ${(validation.checks as any[]).filter((c: any) => !c.passed).length} issue(s):`,
                      diagLines,
                      restored
                        ? '\nFile has been restored to its pre-edit state. Please provide a corrected version.'
                        : ''
                    ].join('\n').trim(),
                    isError: true
                  };
                }
              }
            }

            yield {
              type: 'tool_result',
              toolCall,
              result: finalResult,
              success: !finalResult.isError
            };

            this.messages.push({
              role: 'tool',
              content: finalResult.content,
              tool_call_id: toolCall.id
            });
          }

          // 继续循环，让模型处理工具结果
          continue;
        }

        // 8. 没有工具调用 — 模型已完成回复，直接结束（参考 Reasonix 模式）
        // completenessChecker 移至循环外作为事后报告，不再注入重试消息
        yield {
          type: 'done',
          success: true,
          result: response.content
        };
        break;
      }

      // P0-2 Stop hook
      const stopHook = await this.runHooks('Stop', {});
      if (stopHook.results.length) {
        yield { type: 'hook', event: 'Stop', results: stopHook.results };
      }

      // 使用量统计
      yield {
        type: 'usage',
        usage: {
          totalTokens: this.state.totalTokens,
          totalCostUsd: this.state.totalCostUsd,
          toolCalls: this.state.toolCalls,
          steps: this.state.currentStep
        }
      };

    } catch (error: any) {
      this.state.errors++;
      yield { type: 'error', error: error.message, recoverable: false };
    } finally {
      this.state.running = false;
    }
  }

  /**
   * 调用模型 - 流式
   */
  private async callModel(): Promise<{
    content: string;
    reasoningContent?: string;
    toolCalls?: ToolCall[];
    usage?: any;
  }> {
    const messages = this.getOptimizedMessages();

    let content = '';
    let reasoningContent = '';
    let toolCalls: ToolCall[] = [];
    let usage: any = null;

    for await (const chunk of this.config.client.streamChat({
      messages,
      tools: this.config.tools.getDefinitions(),
      maxTokens: this.config.maxTokens,
      thinking: this.config.thinking
    })) {
      switch (chunk.type) {
        case 'content':
          content += chunk.content;
          this.config.onChunk?.({ type: 'content', text: chunk.content });
          break;
        case 'reasoning':
          reasoningContent += chunk.content;
          this.config.onChunk?.({ type: 'reasoning', text: chunk.content });
          break;
        case 'tool_call':
          if (chunk.toolCall) {
            toolCalls.push(chunk.toolCall);
            this.config.onChunk?.({ type: 'tool_call', name: chunk.toolCall.function.name });
          }
          break;
        case 'usage':
          usage = chunk.usage;
          if (usage) {
            this.state.totalTokens += usage.totalTokens || 0;
          }
          break;
        case 'error':
          throw new Error(chunk.error);
      }
    }

    return {
      content,
      reasoningContent: reasoningContent || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage
    };
  }

  /**
   * 响应容量检查点决策 - 参考 CodeWhale 的 GuardrailAction
   *
   * targeted_refresh: 尽力折叠上下文回收 token
   * verify_and_replan: 注入复核指令，逼模型收尾而非半途断（缓解部分实现）
   */
  private async applyCapacityAction(snapshot: CapacitySnapshot, step: number): Promise<void> {
    if (snapshot.action === 'targeted_refresh') {
      if (this.config.contextManager) {
        await this.optimizeContext();
      }
      this.capacity.recordRefresh(step);
    } else if (snapshot.action === 'verify_and_replan') {
      this.steerQueue.push(
        '[Capacity guard] Context is nearly full. Before continuing, verify what is already done, finish any partially-implemented work, and avoid starting new subtasks.'
      );
      this.capacity.recordRefresh(step);
    }
  }

  /**
   * 运行生命周期钩子 - 参考 Claude Code 的 hook 语义
   * 仅 PreToolUse 在非零退出时阻断工具执行。
   */
  private async runHooks(
    event: 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop',
    ctx: { toolName?: string; toolArgs?: Record<string, any>; toolResult?: any; userPrompt?: string }
  ): Promise<{ block: boolean; reason?: string; results: any[] }> {
    if (!this.config.hookManager) return { block: false, results: [] };
    try {
      const results = await this.config.hookManager.execute(event, {
        workingDirectory: this.config.workingDirectory,
        ...ctx
      });
      const failed = (results as any[]).find((r) => r.success === false);
      return {
        block: event === 'PreToolUse' && !!failed,
        reason: failed?.stderr,
        results: results || []
      };
    } catch {
      return { block: false, results: [] };
    }
  }

  /**
   * 安全解析工具调用参数
   */
  private safeParseArgs(toolCall: ToolCall): Record<string, any> {
    try {
      return JSON.parse(toolCall.function.arguments || '{}');
    } catch {
      return {};
    }
  }

  /**
   * 优化上下文
   */
  private async optimizeContext(): Promise<any> {
    if (!this.config.contextManager) return null;

    const taskState: TaskState = {
      objective: this.messages[0]?.content || '',
      currentStep: this.state.currentStep,
      completedSubtasks: [],
      pendingSubtasks: []
    };

    const result = await this.config.contextManager.optimize({
      messages: this.messages,
      taskState,
      maxTokens: this.config.maxTokens || 131072
    });

    if (result.folded) {
      this.messages = result.messages;
    }

    return result;
  }

  /**
   * 获取优化后的消息
   */
  private getOptimizedMessages(): ChatMessage[] {
    return this.messages;
  }

  /**
   * 修复工具调用 - 参考 DeepSeek-Reasonix 的 repair pipeline
   */
  private repairToolCalls(toolCalls: ToolCall[]): {
    calls: ToolCall[];
    report: { scavenged: number; truncationsFixed: number; stormsBroken: number; notes: string[] };
  } {
    if (!this.config.toolRepair) {
      return {
        calls: toolCalls,
        report: { scavenged: 0, truncationsFixed: 0, stormsBroken: 0, notes: [] }
      };
    }

    const report: { scavenged: number; truncationsFixed: number; stormsBroken: number; notes: string[] } = 
      { scavenged: 0, truncationsFixed: 0, stormsBroken: 0, notes: [] };
    const repaired: ToolCall[] = [];

    for (const tc of toolCalls) {
      // 尝试修复 JSON
      try {
        JSON.parse(tc.function.arguments);
        repaired.push(tc);
      } catch {
        // 修复截断的 JSON
        const fixed = this.repairJson(tc.function.arguments);
        if (fixed.changed) {
          repaired.push({
            ...tc,
            function: { ...tc.function, arguments: fixed.repaired }
          });
          report.truncationsFixed++;
          report.notes.push(`Fixed truncated JSON for ${tc.function?.name || 'unknown'}`);
        } else {
          repaired.push(tc);
        }
      }
    }

    return { calls: repaired, report };
  }

  /**
   * 修复 JSON - 参考 DeepSeek-Reasonix 的 truncation repair
   */
  private repairJson(jsonStr: string): { repaired: string; changed: boolean } {
    try {
      JSON.parse(jsonStr);
      return { repaired: jsonStr, changed: false };
    } catch {
      // 尝试修复
    }

    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    let lastSignificant = -1;

    for (let i = 0; i < jsonStr.length; i++) {
      const c = jsonStr[i] || '';
      if (!/\s/.test(c)) lastSignificant = i;
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{' || c === '[') stack.push(c);
      if (c === '}' || c === ']') stack.pop();
    }

    let s = jsonStr.slice(0, lastSignificant + 1);

    // 移除尾部逗号
    if (/,$/.test(s)) {
      s = s.replace(/,$/, '');
    }

    // 填充悬挂的 key
    if (/"\s*:\s*$/.test(s)) {
      s += ' null';
    }

    // 闭合未终止的字符串
    if (inString) {
      s += '"';
      stack.pop();
    }

    // 闭合括号
    while (stack.length > 0) {
      const top = stack.pop();
      if (top === '{') s += '}';
      else if (top === '[') s += ']';
    }

    try {
      JSON.parse(s);
      return { repaired: s, changed: true };
    } catch {
      return { repaired: '{}', changed: true };
    }
  }

  /**
   * 执行工具（单次）
   */
  private async executeTool(toolCall: ToolCall): Promise<{ content: string; isError?: boolean }> {
    try {
      return await this.config.tools.execute(toolCall, {
        signal: this.abortController?.signal,
        workingDirectory: this.config.workingDirectory
      });
    } catch (error: any) {
      return { content: `工具 "${toolCall.function.name}" 执行失败: ${error.message}`, isError: true };
    }
  }

  /**
   * 执行工具（带瞬时错误重试）
   * 对标 Codex 的 transient-retry 策略：timeout/EBUSY/EAGAIN 最多重试 2 次，指数退避。
   */
  private async executeToolWithRetry(toolCall: ToolCall): Promise<{ content: string; isError?: boolean }> {
    const TRANSIENT = /timeout|ETIMEDOUT|EBUSY|EAGAIN|ECONNRESET|ENFILE|EMFILE/i;
    let last: { content: string; isError?: boolean } = { content: '', isError: true };
    for (let attempt = 0; attempt <= 2; attempt++) {
      const result = await this.executeTool(toolCall);
      if (!result.isError || !TRANSIENT.test(result.content)) return result;
      last = result;
      if (attempt < 2) {
        await new Promise<void>(r => setTimeout(r, 300 * (attempt + 1)));
      }
    }
    return { ...last, content: `[重试 2 次后仍失败] ${last.content}` };
  }

  /**
   * 并行执行只读工具批次（对标 Claude Code 的 parallel tool calls）。
   * 所有工具均为只读 (isReadTool)，无副作用，可安全并发。
   */
  private async *executeReadBatch(calls: ToolCall[]): AsyncGenerator<LoopEvent> {
    // 先 yield 所有 tool_call 事件
    for (const tc of calls) {
      yield { type: 'tool_call', toolCall: tc, repaired: false };
    }

    // 并行执行
    const results = await Promise.all(calls.map(tc => this.executeTool(tc)));

    // 收集结果，标记已读，推入消息
    for (let i = 0; i < calls.length; i++) {
      const tc = calls[i]!;
      const result = results[i]!;
      if (!result.isError) {
        const args = this.safeParseArgs(tc);
        if (args.path) this.readTracker.markRead(args.path, this.config.workingDirectory);
      }
      yield { type: 'tool_result', toolCall: tc, result, success: !result.isError };
      this.messages.push({ role: 'tool', content: result.content, tool_call_id: tc.id });
    }
  }

  /**
   * 判断是否是变异工具
   */
  private isMutatingTool(call: ToolCall): boolean {
    const mutatingTools = ['write_file', 'edit_file', 'exec_shell', 'git_commit', 'git_push'];
    return mutatingTools.includes(call.function.name);
  }

  /**
   * 判断是否是风暴豁免工具
   */
  private isStormExemptTool(call: ToolCall): boolean {
    const exemptTools = ['read_file', 'list_directory', 'git_status', 'git_diff'];
    return exemptTools.includes(call.function.name);
  }

  /**
   * 注入 steer 消息
   */
  steer(text: string): void {
    this.steerQueue.push(text);
  }

  /**
   * 中断执行
   */
  abort(): void {
    this.abortController?.abort();
  }

  /**
   * 获取状态
   */
  getState(): LoopState {
    return { ...this.state };
  }

  /**
   * 获取消息
   */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /**
   * 添加系统消息
   */
  addSystemMessage(content: string): void {
    this.messages.unshift({ role: 'system', content });
  }

  /**
   * 配置更新
   */
  configure(config: Partial<MiMoLoopConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
