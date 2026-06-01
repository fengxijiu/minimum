# MiMo Agentic Coding TUI 实际技术方案

## 基于 DeepSeek-Reasonix 和 CodeWhale 源码分析的定制方案

---

## 一、源码分析总结

### 1.1 DeepSeek-Reasonix 核心设计

**技术栈**：TypeScript + Ink 5 (React 18) + Commander.js

**核心架构**：
```
src/
├── loop.ts              # CacheFirstLoop - 核心循环（1073行）
├── context-manager.ts   # 上下文管理 - fold/compact 策略（345行）
├── tools.ts             # ToolRegistry - 工具注册表（509行）
├── repair/              # 工具调用修复管道
│   ├── flatten.ts       # 展平嵌套JSON
│   ├── scavenge.ts      # 从错误JSON提取有效部分
│   ├── storm.ts         # 处理多个工具调用混乱
│   └── truncation.ts    # 处理截断JSON
├── client.ts            # DeepSeek API 客户端
├── memory/              # 记忆系统
│   ├── runtime.ts       # AppendOnlyLog + VolatileScratch
│   ├── session.ts       # 会话持久化
│   ├── project.ts       # 项目记忆
│   └── user.ts          # 用户记忆
└── ports/               # 端口接口（六角架构）
    ├── model-client.ts
    ├── tool-host.ts
    ├── event-sink.ts
    ├── memory-store.ts
    ├── hook-runner.ts
    └── checkpoint-store.ts
```

**关键设计模式**：

1. **Cache-first 循环**（loop.ts:86-104）
   - `ImmutablePrefix` - 不可变前缀，保持缓存稳定
   - `VolatileScratch` - 可变暂存区
   - `AppendOnlyLog` - 追加日志

2. **上下文管理策略**（context-manager.ts:28-46）
   ```typescript
   HISTORY_FOLD_THRESHOLD = 0.75          # 普通 fold 阈值
   HISTORY_FOLD_AGGRESSIVE_THRESHOLD = 0.78  # 激进 fold 阈值
   FORCE_SUMMARY_THRESHOLD = 0.8          # 强制摘要阈值
   TURN_START_FOLD_THRESHOLD = 0.9        # 开始时 fold 阈值
   ```

3. **工具调用修复**（repair/）
   - 4阶段管道：flatten → scavenge → storm → truncation
   - 自动修复格式错误的 JSON

4. **工具注册表**（tools.ts:21-36）
   - `readOnly` - 只读标记
   - `parallelSafe` - 并行安全
   - `stormExempt` - 风暴豁免
   - `skipTruncationSave` - 跳过截断保存

### 1.2 CodeWhale 核心设计

**技术栈**：Rust + ratatui + tokio

**核心架构**：
```
crates/tui/src/
├── core/
│   ├── engine.rs           # 主引擎（2126行）
│   ├── engine/
│   │   ├── turn_loop.rs    # 主循环（2386行）
│   │   ├── streaming.rs    # 流式处理
│   │   ├── tool_execution.rs
│   │   └── capacity_flow.rs
│   ├── session.rs          # 会话管理
│   └── turn.rs             # 轮次管理
├── tools/                  # 工具系统（50+工具）
│   ├── file.rs             # 文件操作
│   ├── shell.rs            # Shell执行
│   ├── git.rs              # Git操作
│   ├── search.rs           # 搜索
│   ├── subagent/           # 子代理
│   ├── rlm.rs              # Recursive Language Model
│   └── tasks.rs            # 后台任务
├── tui/                    # TUI 界面
│   ├── app.rs              # 应用状态
│   ├── ui.rs               # 渲染逻辑
│   └── widgets/            # 组件
├── sandbox/                # 沙箱安全
│   ├── seatbelt.rs         # macOS
│   ├── landlock.rs         # Linux
│   └── seccomp.rs          # 系统调用过滤
└── memory/                 # 记忆系统
```

**关键设计模式**：

1. **Engine 配置**（engine.rs:78-188）
   - `max_steps` - 最大步骤数
   - `max_subagents` - 最大子代理数
   - `compaction` - 上下文压缩配置
   - `capacity` - 容量控制器配置
   - `lsp_config` - LSP 集成配置

2. **Turn Loop**（turn_loop.rs:54-150）
   - 支持 steer（中途转向）
   - 支持 stream retry（流重试）
   - 支持 auto-compaction（自动压缩）
   - 支持 capacity checkpoints（容量检查点）

3. **工具执行流程**
   ```
   LLM请求 → 工具查找 → Pre-hooks → 审批 → 执行 → Post-hooks → LSP诊断 → 返回结果
   ```

4. **沙箱安全**
   - macOS Seatbelt - 沙箱配置文件
   - Linux Landlock - 文件系统沙箱
   - seccomp - 系统调用过滤

---

## 二、MiMo TUI 定制方案

### 2.1 技术选型

| 维度 | DeepSeek-Reasonix | CodeWhale | MiMo TUI | 理由 |
|------|-------------------|-----------|----------|------|
| 语言 | TypeScript | Rust | **TypeScript** | 生态丰富，开发效率高 |
| TUI框架 | Ink 5 | ratatui | **Ink 5** | React 生态，组件化 |
| 异步 | Node.js event loop | tokio | **Node.js** | 原生支持 |
| 测试 | Vitest | cargo test | **Vitest** | 快速，ESM原生 |
| 构建 | tsup | cargo | **tsup** | 快速打包 |

**选择 TypeScript 的理由**：
1. MiMo 模型 API 兼容 OpenAI 格式，TypeScript 生态更成熟
2. Ink 5 基于 React，UI 开发更灵活
3. DeepSeek-Reasonix 的很多设计可以直接复用

### 2.2 核心模块设计

#### 2.2.1 主循环 - MiMoLoop

参考 DeepSeek-Reasonix 的 `CacheFirstLoop`，但针对 MiMo 优化：

```typescript
// src/core/loop.ts
import type { MiMoClient } from '../adapters/mimo-client.js';
import type { ToolRegistry } from './tool-manager.js';
import type { ContextManager } from './context-manager.js';
import type { ToolCallRepair } from './repair/index.js';

/**
 * MiMo 主循环 - 参考 DeepSeek-Reasonix 的 CacheFirstLoop
 * 
 * 关键差异：
 * 1. MiMo 不需要 prefix-cache 稳定性（因为不是 DeepSeek）
 * 2. MiMo 需要更强的上下文压缩（长会话优化）
 * 3. MiMo 需要工具调用验证（而不是修复）
 */
export class MiMoLoop {
  readonly client: MiMoClient;
  readonly tools: ToolRegistry;
  readonly context: ContextManager;
  readonly repair: ToolCallRepair;
  
  // 参考 DeepSeek-Reasonix 的 AppendOnlyLog
  private log: AppendOnlyLog;
  private scratch: VolatileScratch;
  private stats: SessionStats;
  
  // 参考 CodeWhale 的 capacity controller
  private capacity: CapacityController;
  
  // 参考 DeepSeek-Reasonix 的 ReadTracker
  private readTracker: ReadTracker;
  
  // 参考 CodeWhale 的 loop guard
  private loopGuard: LoopGuard;

  constructor(options: MiMoLoopOptions) {
    this.client = options.client;
    this.tools = options.tools;
    this.context = new ContextManager({
      client: this.client,
      log: this.log,
      stats: this.stats,
      // 参考 DeepSeek-Reasonix 的阈值设置
      foldThreshold: 0.75,
      aggressiveThreshold: 0.78,
      forceSummaryThreshold: 0.8,
    });
    this.repair = new ToolCallRepair();
    this.capacity = new CapacityController(options.capacity);
    this.readTracker = new ReadTracker();
    this.loopGuard = new LoopGuard();
  }

  /**
   * 主循环 - 参考 DeepSeek-Reasonix 的 step() 方法
   */
  async *run(userInput: string): AsyncGenerator<LoopEvent> {
    // 1. 添加用户消息到日志
    this.log.append({
      role: 'user',
      content: userInput,
      timestamp: Date.now(),
    });

    // 2. 主循环
    let turn = 0;
    const maxSteps = this.config.maxSteps || 50;
    
    while (turn < maxSteps) {
      // 参考 CodeWhale 的 cancel check
      if (this.cancelToken.isCancelled()) {
        yield { type: 'cancelled' };
        break;
      }

      // 参考 DeepSeek-Reasonix 的 steer queue
      while (this.steerQueue.length > 0) {
        const steer = this.steerQueue.shift()!;
        this.log.append({
          role: 'user',
          content: `[Mid-turn steer] ${steer}`,
          timestamp: Date.now(),
        });
      }

      // 3. 获取优化后的消息
      const messages = await this.context.optimize(
        this.log.toMessages(),
        this.getSystemPrompt()
      );

      // 4. 调用模型
      const response = await this.client.chat({
        messages,
        tools: this.tools.getDefinitions(),
        stream: true,
      });

      // 5. 处理流式响应
      let assistantMessage: ChatMessage = {
        role: 'assistant',
        content: '',
      };

      for await (const chunk of response) {
        switch (chunk.type) {
          case 'content':
            assistantMessage.content += chunk.content;
            yield { type: 'content', content: chunk.content };
            break;

          case 'tool_calls':
            assistantMessage.tool_calls = chunk.tool_calls;
            yield { type: 'tool_calls', tool_calls: chunk.tool_calls };
            break;

          case 'usage':
            this.stats.recordUsage(chunk.usage);
            yield { type: 'usage', usage: chunk.usage };
            break;
        }
      }

      // 6. 工具调用修复（参考 DeepSeek-Reasonix 的 repair pipeline）
      if (assistantMessage.tool_calls) {
        const repairResult = this.repair.repair(assistantMessage.tool_calls);
        if (repairResult.repaired) {
          assistantMessage.tool_calls = repairResult.tool_calls;
          yield { type: 'repair', report: repairResult.report };
        }
      }

      // 7. 添加助手消息到日志
      this.log.append(assistantMessage);

      // 8. 执行工具调用
      if (assistantMessage.tool_calls) {
        const toolResults = await this.executeToolCalls(
          assistantMessage.tool_calls
        );
        
        // 添加工具结果到日志
        for (const result of toolResults) {
          this.log.append(result);
        }

        // 参考 CodeWhale 的 capacity check
        const capacityDecision = this.capacity.check({
          messages: this.log.toMessages(),
          turn,
          toolCalls: assistantMessage.tool_calls,
        });

        if (capacityDecision.action === 'stop') {
          yield { type: 'capacity_limit', decision: capacityDecision };
          break;
        }

        turn++;
        continue;
      }

      // 9. 没有工具调用，结束循环
      break;
    }

    // 10. 参考 DeepSeek-Reasonix 的 session save
    if (this.config.session) {
      await this.saveSession();
    }
  }

  /**
   * 执行工具调用 - 参考 CodeWhale 的 tool execution
   */
  private async executeToolCalls(
    toolCalls: ToolCall[]
  ): Promise<ChatMessage[]> {
    const results: ChatMessage[] = [];

    // 参考 DeepSeek-Reasonix 的 parallel safe 检查
    const parallelSafe = toolCalls.filter(tc => 
      this.tools.isParallelSafe(tc.function.name)
    );
    const sequential = toolCalls.filter(tc => 
      !this.tools.isParallelSafe(tc.function.name)
    );

    // 并行执行安全的工具
    if (parallelSafe.length > 0) {
      const parallelResults = await Promise.allSettled(
        parallelSafe.map(tc => this.executeToolCall(tc))
      );
      results.push(...parallelResults.map(r => 
        r.status === 'fulfilled' ? r.value : this.createErrorMessage(r.reason)
      ));
    }

    // 顺序执行其他工具
    for (const tc of sequential) {
      const result = await this.executeToolCall(tc);
      results.push(result);
    }

    return results;
  }

  /**
   * 执行单个工具调用
   */
  private async executeToolCall(toolCall: ToolCall): Promise<ChatMessage> {
    const { name, arguments: argsStr } = toolCall.function;

    // 参考 DeepSeek-Reasonix 的 readTracker 检查
    if (this.tools.isEditTool(name)) {
      const args = JSON.parse(argsStr);
      if (!this.readTracker.hasRead(args.path)) {
        return {
          role: 'tool',
          content: `Error: File ${args.path} has not been read yet. Please read it first.`,
          tool_call_id: toolCall.id,
        };
      }
    }

    // 参考 CodeWhale 的 approval 检查
    if (this.tools.requiresApproval(name)) {
      const approved = await this.requestApproval(toolCall);
      if (!approved) {
        return {
          role: 'tool',
          content: 'Tool call rejected by user.',
          tool_call_id: toolCall.id,
        };
      }
    }

    try {
      // 执行工具
      const result = await this.tools.execute(toolCall, {
        signal: this.abortController.signal,
        workingDirectory: this.config.workingDirectory,
      });

      // 参考 DeepSeek-Reasonix 的 ReadTracker 更新
      if (this.tools.isReadTool(name)) {
        const args = JSON.parse(argsStr);
        this.readTracker.markRead(args.path);
      }

      return {
        role: 'tool',
        content: result.content,
        tool_call_id: toolCall.id,
      };
    } catch (error) {
      return {
        role: 'tool',
        content: `Error: ${error}`,
        tool_call_id: toolCall.id,
      };
    }
  }
}
```

#### 2.2.2 上下文管理器 - ContextManager

参考 DeepSeek-Reasonix 的 `ContextManager`：

```typescript
// src/core/context-manager.ts
import type { DeepSeekClient } from './client.js';
import type { AppendOnlyLog } from './memory/runtime.js';

/**
 * 上下文管理器 - 参考 DeepSeek-Reasonix 的 ContextManager
 * 
 * 关键策略：
 * 1. fold - 折叠旧消息
 * 2. compact - 压缩消息
 * 3. force summary - 强制摘要
 */
export class ContextManager {
  // 参考 DeepSeek-Reasonix 的阈值
  private readonly FOLD_THRESHOLD = 0.75;
  private readonly AGGRESSIVE_THRESHOLD = 0.78;
  private readonly FORCE_SUMMARY_THRESHOLD = 0.8;
  private readonly TURN_START_THRESHOLD = 0.9;

  constructor(private deps: ContextManagerDeps) {}

  /**
   * 优化消息列表
   */
  async optimize(
    messages: ChatMessage[],
    systemPrompt: string
  ): Promise<ChatMessage[]> {
    // 1. 计算当前 token 数
    const currentTokens = this.countTokens(messages);
    const maxTokens = this.getMaxTokens();
    const ratio = currentTokens / maxTokens;

    // 2. 参考 DeepSeek-Reasonix 的 fold 策略
    if (ratio > this.TURN_START_THRESHOLD) {
      // 开始时就需要 fold
      return await this.fold(messages, systemPrompt, 'aggressive');
    }

    if (ratio > this.FORCE_SUMMARY_THRESHOLD) {
      // 强制摘要
      return await this.forceSummary(messages, systemPrompt);
    }

    // 3. 返回优化后的消息
    return messages;
  }

  /**
   * 折叠消息 - 参考 DeepSeek-Reasonix 的 fold
   */
  private async fold(
    messages: ChatMessage[],
    systemPrompt: string,
    mode: 'normal' | 'aggressive'
  ): Promise<ChatMessage[]> {
    // 1. 分离系统消息和历史消息
    const systemMessages = messages.filter(m => m.role === 'system');
    const historyMessages = messages.filter(m => m.role !== 'system');

    // 2. 参考 DeepSeek-Reasonix 的 tail budget
    const tailFraction = mode === 'aggressive' ? 0.1 : 0.2;
    const tailCount = Math.floor(historyMessages.length * tailFraction);

    // 3. 保留最近的消息
    const recentMessages = historyMessages.slice(-tailCount);
    const oldMessages = historyMessages.slice(0, -tailCount);

    // 4. 生成摘要
    const summary = await this.generateSummary(oldMessages);

    // 5. 参考 DeepSeek-Reasonix 的 HISTORY_FOLD_MARKER
    const summaryMessage: ChatMessage = {
      role: 'assistant',
      content: `[Context folded - previous conversation summarized]\n${summary}`,
    };

    // 6. 参考 DeepSeek-Reasonix 的 SKILL_PIN_MEMO_HEADER
    const pinnedSkills = this.extractPinnedSkills(oldMessages);
    if (pinnedSkills.length > 0) {
      summaryMessage.content += `\n\n[Pinned skill memos preserved verbatim]\n${pinnedSkills.join('\n')}`;
    }

    return [...systemMessages, summaryMessage, ...recentMessages];
  }

  /**
   * 生成摘要 - 使用 MiMo 模型
   */
  private async generateSummary(messages: ChatMessage[]): Promise<string> {
    const response = await this.deps.client.chat({
      messages: [
        {
          role: 'system',
          content: 'Summarize the conversation concisely. Preserve: objectives, decisions, files modified, tool results, open todos. Skip turn-by-turn details.',
        },
        ...messages,
      ],
      maxTokens: 500,
    });

    return response.content;
  }

  /**
   * 提取 pinned skills - 参考 DeepSeek-Reasonix
   */
  private extractPinnedSkills(messages: ChatMessage[]): string[] {
    const pinned: string[] = [];
    const regex = /<skill-pin name="([^"]+)">\n([\s\S]*?)\n<\/skill-pin>/g;

    for (const msg of messages) {
      if (typeof msg.content !== 'string') continue;
      
      let match;
      while ((match = regex.exec(msg.content)) !== null) {
        pinned.push(match[0]);
      }
    }

    return pinned;
  }

  /**
   * 计算 token 数 - 参考 DeepSeek-Reasonix 的 countTokensBounded
   */
  private countTokens(messages: ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      // 简化计算：1 token ≈ 4 characters
      total += Math.ceil((msg.content?.length || 0) / 4);
      if (msg.tool_calls) {
        total += Math.ceil(JSON.stringify(msg.tool_calls).length / 4);
      }
    }
    return total;
  }
}
```

#### 2.2.3 工具调用修复 - ToolCallRepair

参考 DeepSeek-Reasonix 的 `repair/` 模块：

```typescript
// src/core/repair/index.ts
import { flattenSchema, nestArguments } from './flatten.js';
import { scavengeJson } from './scavenge.js';
import { fixStorm } from './storm.js';
import { fixTruncation } from './truncation.js';

/**
 * 工具调用修复管道 - 参考 DeepSeek-Reasonix 的 4 阶段修复
 * 
 * 1. Flatten - 展平嵌套的 JSON schema
 * 2. Scavenge - 从错误的 JSON 中提取有效部分
 * 3. Storm - 处理多个工具调用的混乱情况
 * 4. Truncation - 处理截断的 JSON
 */
export class ToolCallRepair {
  /**
   * 修复工具调用
   */
  repair(toolCalls: ToolCall[]): {
    repaired: boolean;
    tool_calls: ToolCall[];
    report: RepairReport;
  } {
    const changes: RepairChange[] = [];
    const repaired: ToolCall[] = [];

    for (const tc of toolCalls) {
      let fixed = { ...tc };
      const original = tc.function.arguments;

      // 1. 尝试解析 JSON
      let args: any;
      try {
        args = JSON.parse(fixed.function.arguments);
      } catch {
        // JSON 解析失败，尝试修复
        const result = this.repairJson(fixed.function.arguments);
        if (result.fixed) {
          args = result.value;
          changes.push({
            type: result.type,
            description: result.description,
            before: original,
            after: JSON.stringify(args),
          });
        } else {
          // 无法修复，保留原始
          repaired.push(tc);
          continue;
        }
      }

      // 2. 参考 DeepSeek-Reasonix 的 flatten
      const flattened = this.flattenIfNeeded(args);
      if (JSON.stringify(flattened) !== JSON.stringify(args)) {
        changes.push({
          type: 'flatten',
          description: 'Flattened nested JSON structure',
          before: JSON.stringify(args),
          after: JSON.stringify(flattened),
        });
        args = flattened;
      }

      // 3. 清理字符串值
      const cleaned = this.cleanStringValues(args);
      if (JSON.stringify(cleaned) !== JSON.stringify(args)) {
        changes.push({
          type: 'clean',
          description: 'Cleaned string values',
          before: JSON.stringify(args),
          after: JSON.stringify(cleaned),
        });
        args = cleaned;
      }

      repaired.push({
        ...fixed,
        function: {
          ...fixed.function,
          arguments: JSON.stringify(args),
        },
      });
    }

    return {
      repaired: changes.length > 0,
      tool_calls: repaired,
      report: {
        original: toolCalls,
        repaired,
        changes,
      },
    };
  }

  /**
   * 修复 JSON - 参考 DeepSeek-Reasonix 的 4 阶段修复
   */
  private repairJson(jsonStr: string): RepairResult {
    // 1. 参考 DeepSeek-Reasonix 的 truncation 修复
    const truncationResult = fixTruncation(jsonStr);
    if (truncationResult.fixed) {
      return {
        ...truncationResult,
        type: 'truncation',
        description: 'Fixed truncated JSON',
      };
    }

    // 2. 参考 DeepSeek-Reasonix 的 storm 修复
    const stormResult = fixStorm(jsonStr);
    if (stormResult.fixed) {
      return {
        ...stormResult,
        type: 'storm',
        description: 'Fixed multiple JSON objects',
      };
    }

    // 3. 参考 DeepSeek-Reasonix 的 scavenge 修复
    const scavengeResult = scavengeJson(jsonStr);
    if (scavengeResult.fixed) {
      return {
        ...scavengeResult,
        type: 'scavenge',
        description: 'Extracted valid JSON from malformed string',
      };
    }

    return { fixed: false, value: null, type: 'scavenge', description: '' };
  }

  /**
   * 展平 - 参考 DeepSeek-Reasonix 的 flattenSchema
   */
  private flattenIfNeeded(args: any): any {
    if (typeof args !== 'object' || args === null) {
      return args;
    }

    // 检查是否需要展平
    const depth = this.getDepth(args);
    if (depth <= 2) {
      return args;
    }

    // 展平
    return flattenSchema(args);
  }

  private getDepth(obj: any): number {
    if (typeof obj !== 'object' || obj === null) {
      return 0;
    }
    let maxDepth = 0;
    for (const value of Object.values(obj)) {
      const depth = this.getDepth(value);
      maxDepth = Math.max(maxDepth, depth);
    }
    return maxDepth + 1;
  }
}
```

#### 2.2.4 工具注册表 - ToolRegistry

参考 DeepSeek-Reasonix 的 `ToolRegistry`：

```typescript
// src/core/tool-manager.ts
import type { ToolCallContext } from './loop.js';

/**
 * 工具注册表 - 参考 DeepSeek-Reasonix 的 ToolRegistry
 */
export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  
  // 参考 DeepSeek-Reasonix 的 plan mode
  private planMode = false;
  
  // 参考 DeepSeek-Reasonix 的 interceptors
  private interceptors: Array<{ id: string; fn: ToolInterceptor }> = [];
  
  // 参考 DeepSeek-Reasonix 的 rate limiter
  private rateLimiter: ToolRateLimiter;
  
  // 参考 CodeWhale 的 approval cache
  private approvalCache: Map<string, boolean> = new Map();

  constructor(options: ToolRegistryOptions = {}) {
    this.rateLimiter = new ToolRateLimiter(options.rateLimit);
  }

  /**
   * 注册工具
   */
  register(definition: ToolDefinition): this {
    if (!definition.name) {
      throw new Error('Tool requires a name');
    }
    
    // 参考 DeepSeek-Reasonix 的 auto-flatten
    if (definition.parameters) {
      const decision = analyzeSchema(definition.parameters);
      if (decision.shouldFlatten) {
        definition.flatSchema = flattenSchema(definition.parameters);
      }
    }
    
    this.tools.set(definition.name, definition);
    return this;
  }

  /**
   * 执行工具
   */
  async execute(
    toolCall: ToolCall,
    context: ToolCallContext
  ): Promise<ToolResult> {
    const { name, arguments: argsStr } = toolCall.function;
    const tool = this.tools.get(name);

    if (!tool) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }

    // 参考 DeepSeek-Reasonix 的 plan mode 检查
    if (this.planMode && !tool.readOnly) {
      return { 
        content: `Tool ${name} is not allowed in plan mode (not read-only)`,
        isError: true 
      };
    }

    // 参考 DeepSeek-Reasonix 的 rate limit 检查
    if (!this.rateLimiter.check(name)) {
      return { 
        content: `Rate limit exceeded for tool ${name}`,
        isError: true 
      };
    }

    // 参考 DeepSeek-Reasonix 的 interceptor 检查
    for (const interceptor of this.interceptors) {
      const result = await interceptor.fn(name, JSON.parse(argsStr));
      if (result !== null && result !== undefined) {
        return { content: result };
      }
    }

    // 解析参数
    let args: any;
    try {
      args = JSON.parse(argsStr);
    } catch (error) {
      return { content: `Invalid JSON arguments: ${error}`, isError: true };
    }

    // 参考 DeepSeek-Reasonix 的 nestArguments
    if (tool.flatSchema) {
      args = nestArguments(args, tool.parameters);
    }

    // 执行工具
    try {
      const result = await tool.fn(args, context);
      return { content: result };
    } catch (error) {
      return { content: `Tool execution failed: ${error}`, isError: true };
    }
  }

  /**
   * 检查是否并行安全
   */
  isParallelSafe(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.parallelSafe ?? false;
  }

  /**
   * 检查是否需要审批
   */
  requiresApproval(name: string): boolean {
    const tool = this.tools.get(name);
    return !tool?.readOnly;
  }

  /**
   * 检查是否是编辑工具
   */
  isEditTool(name: string): boolean {
    return ['edit_file', 'write_file', 'multi_edit'].includes(name);
  }

  /**
   * 检查是否是读取工具
   */
  isReadTool(name: string): boolean {
    return ['read_file', 'glob', 'grep'].includes(name);
  }
}
```

#### 2.2.5 记忆系统 - Memory System

参考 DeepSeek-Reasonix 的 `memory/` 模块：

```typescript
// src/memory/runtime.ts
/**
 * 运行时记忆 - 参考 DeepSeek-Reasonix 的 AppendOnlyLog + VolatileScratch
 */
export class AppendOnlyLog {
  private entries: LogEntry[] = [];

  append(entry: LogEntry): void {
    this.entries.push({
      ...entry,
      timestamp: entry.timestamp || Date.now(),
    });
  }

  toMessages(): ChatMessage[] {
    return this.entries.map(e => ({
      role: e.role,
      content: e.content,
      tool_calls: e.tool_calls,
      tool_call_id: e.tool_call_id,
    }));
  }

  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}

export class VolatileScratch {
  private data: Map<string, any> = new Map();

  set(key: string, value: any): void {
    this.data.set(key, value);
  }

  get(key: string): any {
    return this.data.get(key);
  }

  clear(): void {
    this.data.clear();
  }
}

// src/memory/session.ts
/**
 * 会话记忆 - 参考 DeepSeek-Reasonix 的 session 持久化
 */
export class SessionMemory {
  private sessionPath: string;

  constructor(sessionPath: string) {
    this.sessionPath = sessionPath;
  }

  async save(messages: ChatMessage[], metadata: SessionMeta): Promise<void> {
    const data = {
      version: 1,
      messages,
      metadata,
      savedAt: new Date().toISOString(),
    };

    await fs.writeFile(
      this.sessionPath,
      JSON.stringify(data, null, 2),
      'utf-8'
    );
  }

  async load(): Promise<{ messages: ChatMessage[]; metadata: SessionMeta }> {
    try {
      const content = await fs.readFile(this.sessionPath, 'utf-8');
      const data = JSON.parse(content);
      return {
        messages: data.messages || [],
        metadata: data.metadata || {},
      };
    } catch {
      return { messages: [], metadata: {} };
    }
  }
}

// src/memory/project.ts
/**
 * 项目记忆 - 参考 DeepSeek-Reasonix 的 project memory
 */
export class ProjectMemory {
  private memoryPath: string;

  constructor(projectRoot: string) {
    this.memoryPath = path.join(projectRoot, '.mimo', 'memory.md');
  }

  async load(): Promise<string> {
    try {
      return await fs.readFile(this.memoryPath, 'utf-8');
    } catch {
      return '';
    }
  }

  async save(content: string): Promise<void> {
    await fs.mkdir(path.dirname(this.memoryPath), { recursive: true });
    await fs.writeFile(this.memoryPath, content, 'utf-8');
  }
}
```

### 2.3 TUI 界面设计

参考 DeepSeek-Reasonix 的 Ink 5 组件：

```typescript
// src/cli/ui/App.tsx
import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import { MiMoLoop } from '../../core/loop.js';
import { ChatView } from './ChatView.js';
import { StatusBar } from './StatusBar.js';
import { InputBox } from './InputBox.js';

/**
 * 主应用 - 参考 DeepSeek-Reasonix 的 App 组件
 */
export const App: React.FC<AppProps> = ({
  client,
  tools,
  workingDirectory,
  budgetUsd,
}) => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [totalCost, setTotalCost] = useState(0);
  const [totalTokens, setTotalTokens] = useState(0);

  const loop = new MiMoLoop({
    client,
    tools,
    workingDirectory,
    budgetUsd,
  });

  const handleSubmit = useCallback(async (input: string) => {
    if (!input.trim() || isProcessing) return;

    setIsProcessing(true);
    setMessages(prev => [...prev, { role: 'user', content: input }]);

    let assistantContent = '';
    for await (const event of loop.run(input)) {
      switch (event.type) {
        case 'content':
          assistantContent += event.content;
          setMessages(prev => {
            const newMessages = [...prev];
            const lastMsg = newMessages[newMessages.length - 1];
            if (lastMsg.role === 'assistant') {
              lastMsg.content = assistantContent;
            } else {
              newMessages.push({ role: 'assistant', content: assistantContent });
            }
            return newMessages;
          });
          break;

        case 'tool_calls':
          setMessages(prev => [
            ...prev,
            { role: 'system', content: `Calling tools: ${event.tool_calls.map(tc => tc.function.name).join(', ')}` },
          ]);
          break;

        case 'usage':
          setTotalCost(prev => prev + (event.usage.cost || 0));
          setTotalTokens(prev => prev + (event.usage.total_tokens || 0));
          break;

        case 'error':
          setMessages(prev => [
            ...prev,
            { role: 'error', content: event.message },
          ]);
          break;
      }
    }

    setIsProcessing(false);
  }, [isProcessing, loop]);

  // 参考 DeepSeek-Reasonix 的键盘快捷键
  useInput((key, info) => {
    if (info.ctrl && key === 'c') {
      exit();
    }
    if (info.ctrl && key === 'l') {
      setMessages([]);
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      {/* 参考 DeepSeek-Reasonix 的状态栏 */}
      <StatusBar
        cost={totalCost}
        tokens={totalTokens}
        budget={budgetUsd}
        isProcessing={isProcessing}
      />

      {/* 参考 DeepSeek-Reasonix 的聊天视图 */}
      <ChatView messages={messages} />

      {/* 参考 DeepSeek-Reasonix 的输入框 */}
      <InputBox
        onSubmit={handleSubmit}
        isProcessing={isProcessing}
        placeholder="Type your message..."
      />
    </Box>
  );
};
```

---

## 三、关键差异对比

### 3.1 DeepSeek-Reasonix vs MiMo TUI

| 特性 | DeepSeek-Reasonix | MiMo TUI |
|------|-------------------|----------|
| 缓存策略 | Prefix-cache 稳定 | 上下文压缩 |
| 工具修复 | 4阶段修复管道 | 简化修复 + 验证 |
| 上下文管理 | fold + compact | fold + summary |
| 模型支持 | DeepSeek 专用 | MiMo 专用 |
| TUI 框架 | Ink 5 | Ink 5 |
| 测试框架 | Vitest | Vitest |

### 3.2 CodeWhale vs MiMo TUI

| 特性 | CodeWhale | MiMo TUI |
|------|-----------|----------|
| 语言 | Rust | TypeScript |
| TUI 框架 | ratatui | Ink 5 |
| 异步运行时 | tokio | Node.js |
| 沙箱 | 座椅安全带/Landlock | 无 |
| LSP 集成 | 是 | 否（可选） |
| 子代理 | 是 | 是 |

---

## 四、实施计划

### 4.1 第一阶段：核心框架（2周）

1. **搭建项目结构**
   - 参考 DeepSeek-Reasonix 的目录结构
   - 配置 TypeScript、Vitest、Biome

2. **实现 MiMoLoop**
   - 参考 DeepSeek-Reasonix 的 CacheFirstLoop
   - 实现基本的对话循环

3. **实现 ToolRegistry**
   - 参考 DeepSeek-Reasonix 的 ToolRegistry
   - 实现工具注册和执行

4. **实现 ContextManager**
   - 参考 DeepSeek-Reasonix 的 ContextManager
   - 实现基本的 fold 策略

### 4.2 第二阶段：工具系统（2周）

1. **实现文件系统工具**
   - read_file, write_file, edit_file
   - 参考 DeepSeek-Reasonix 的 filesystem 工具

2. **实现 Shell 工具**
   - exec_shell
   - 参考 CodeWhale 的 shell 工具

3. **实现搜索工具**
   - glob, grep
   - 参考 DeepSeek-Reasonix 的 search 工具

4. **实现工具调用修复**
   - 参考 DeepSeek-Reasonix 的 repair 模块

### 4.3 第三阶段：TUI 界面（2周）

1. **实现主界面**
   - 参考 DeepSeek-Reasonix 的 Ink 组件
   - 实现 ChatView, StatusBar, InputBox

2. **实现快捷键**
   - 参考 DeepSeek-Reasonix 的键盘处理

3. **实现流式显示**
   - 参考 DeepSeek-Reasonix 的流式渲染

### 4.4 第四阶段：高级功能（2周）

1. **实现记忆系统**
   - 参考 DeepSeek-Reasonix 的 memory 模块
   - 实现 session, project, user 记忆

2. **实现 MCP 支持**
   - 参考 DeepSeek-Reasonix 的 mcp 模块

3. **实现 Skills 系统**
   - 参考 CodeWhale 的 skills 系统

4. **实现配置系统**
   - 参考 DeepSeek-Reasonix 的 config 模块

---

## 五、配置文件

### 5.1 项目配置

```json
// package.json
{
  "name": "mimo-tui",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "mimo": "dist/cli/index.js"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/cli/index.ts",
    "test": "vitest run",
    "lint": "biome check src tests",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "ink": "^5.0.0",
    "react": "^18.0.0",
    "commander": "^12.0.0"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "tsx": "^4.0.0",
    "vitest": "^2.0.0",
    "biome": "^1.9.0",
    "@types/react": "^18.0.0"
  }
}
```

### 5.2 用户配置

```json
// ~/.mimo/config.json
{
  "model": "mimo-v2.5-pro",
  "maxTokens": 4096,
  "temperature": 0.7,
  "budgetUsd": 10.0,
  "maxSteps": 50,
  "foldThreshold": 0.75,
  "aggressiveThreshold": 0.78,
  "forceSummaryThreshold": 0.8,
  "tools": {
    "enabled": ["filesystem", "shell", "search"],
    "approval": {
      "shell": "ask",
      "filesystem": "allow"
    }
  }
}
```

---

## 六、总结

### 6.1 核心特性

1. **上下文优先循环** - 参考 DeepSeek-Reasonix 的 CacheFirstLoop
2. **工具调用修复** - 参考 DeepSeek-Reasonix 的 4 阶段修复管道
3. **智能上下文管理** - 参考 DeepSeek-Reasonix 的 fold 策略
4. **流式响应** - 实时显示模型输出
5. **成本控制** - 防止 API 费用超支

### 6.2 参考来源

- **DeepSeek-Reasonix**: CacheFirstLoop, ContextManager, ToolRegistry, repair/, memory/
- **CodeWhale**: Engine, turn_loop, sandbox, skills, subagent

### 6.3 下一步

1. 搭建项目框架
2. 实现核心模块
3. 添加工具系统
4. 构建 TUI 界面
5. 测试和优化
6. 文档和发布

---

**文档版本**: 2.0.0  
**最后更新**: 2026-05-27  
**基于**: DeepSeek-Reasonix 和 CodeWhale 源码分析