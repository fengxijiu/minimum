import type { ChatMessage, ToolCall, ToolDefinition } from '../types/common.js';
import type { MiMoClient, StreamChunk } from '../clients/MiMoClient.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import type { ICodeValidator } from '../types/validator.js';
import type { IToolCallRepair } from '../types/repair.js';
import type { ICompletenessChecker } from '../types/completeness.js';
import type { IContextManager, TaskState } from '../types/context.js';
import type { IIterationManager } from '../types/iteration.js';
import { StormBreaker } from '../repair/StormBreaker.js';

// ============ Types ============

export interface MiMoLoopConfig {
  client: any; // MiMoClient or compatible
  tools: any;  // ToolRegistry or compatible
  validator?: any;
  toolRepair?: any;
  completenessChecker?: any;
  contextManager?: any;
  iterationManager?: any;
  hookManager?: any;
  approvalManager?: any;
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
      { windowSize: 6, threshold: 3 },
      (call) => this.isMutatingTool(call),
      (call) => this.isStormExemptTool(call)
    );
  }

  /**
   * 主执行循环 - 参考 DeepSeek-Reasonix 的 step() 和 CodeWhale 的 handle_deepseek_turn()
   */
  async *run(userInput: string): AsyncGenerator<LoopEvent> {
    this.abortController = new AbortController();
    this.state.running = true;
    this.state.startTime = Date.now();
    this.stormBreaker.reset();

    try {
      // 1. 添加用户消息
      this.messages.push({ role: 'user', content: userInput });

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

            // 执行工具
            this.state.toolCalls++;
            const result = await this.executeTool(toolCall);

            // 验证结果
            if (this.config.validator && !result.isError) {
              const validation = await this.config.validator.validate({
                toolName: toolCall.function.name,
                toolArgs: JSON.parse(toolCall.function.arguments || '{}'),
                toolResult: result
              });
              
              if (!validation.passed) {
                yield { type: 'validation', result: validation };
              }
            }

            yield {
              type: 'tool_result',
              toolCall,
              result,
              success: !result.isError
            };

            this.messages.push({
              role: 'tool',
              content: result.content,
              tool_call_id: toolCall.id
            });
          }

          // 继续循环，让模型处理工具结果
          continue;
        }

        // 8. 没有工具调用，检查完整性
        if (this.config.completenessChecker && response.content) {
          const completenessResult = await this.config.completenessChecker.check({
            task: userInput,
            generatedCode: response.content,
            context: {
              projectRoot: this.config.workingDirectory,
              readFiles: [],
              modifiedFiles: [],
              language: 'typescript'
            }
          });

          yield { type: 'completeness', result: completenessResult };

          if (!completenessResult.complete) {
            // 提示模型继续完善
            this.messages.push({
              role: 'user',
              content: `Please continue and address these issues:\n${completenessResult.suggestions.join('\n')}`
            });
            continue;
          }
        }

        // 9. 任务完成
        yield {
          type: 'done',
          success: true,
          result: response.content
        };
        break;
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
          break;
        case 'reasoning':
          reasoningContent += chunk.content;
          break;
        case 'tool_call':
          if (chunk.toolCall) {
            toolCalls.push(chunk.toolCall);
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
   * 执行工具
   */
  private async executeTool(toolCall: ToolCall): Promise<{ content: string; isError?: boolean }> {
    try {
      return await this.config.tools.execute(toolCall, {
        signal: this.abortController?.signal,
        workingDirectory: this.config.workingDirectory
      });
    } catch (error: any) {
      return { content: `Tool execution failed: ${error.message}`, isError: true };
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
