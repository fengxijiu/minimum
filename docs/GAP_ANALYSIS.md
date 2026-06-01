# Minimum vs DeepSeek-Reasonix & CodeWhale 功能对比

## 一、功能对比矩阵

### 1.1 核心循环

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| 主循环 | CacheFirstLoop | Engine + turn_loop | MiMoLoop | - |
| 流式响应 | ✅ | ✅ | ✅ | - |
| 上下文折叠 | ✅ (fold/compact) | ✅ (compaction) | ✅ (MessageFolder) | - |
| 容量控制 | ✅ (budget) | ✅ (CapacityController) | ❌ | **缺失** |
| 循环管理 | ❌ | ✅ (CycleManager) | ❌ | **缺失** |
| 一致性状态 | ❌ | ✅ (CoherenceState) | ❌ | **缺失** |

### 1.2 工具调用修复

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| JSON修复 | ✅ (truncation) | ✅ | ✅ | - |
| 类型修复 | ✅ (flatten) | ✅ | ✅ | - |
| 值修复 | ✅ (scavenge) | ✅ | ✅ | - |
| 路径修复 | ✅ | ✅ | ✅ | - |
| 风暴检测 | ✅ (StormBreaker) | ✅ (LoopGuard) | ❌ | **缺失** |
| DSML提取 | ✅ (scavenge) | ❌ | ❌ | **缺失** |

### 1.3 记忆系统

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| 会话记忆 | ✅ (JSONL) | ✅ (SQLite) | ✅ | - |
| 项目记忆 | ✅ (REASONIX.md) | ✅ | ✅ | - |
| 用户记忆 | ✅ (MEMORY.md) | ✅ (memory.md) | ✅ | - |
| 运行时记忆 | ✅ (AppendOnlyLog) | ✅ | ❌ | **缺失** |
| 记忆索引 | ✅ (MEMORY.md index) | ❌ | ❌ | **缺失** |
| 记忆优先级 | ✅ (high/medium/low) | ❌ | ❌ | **缺失** |
| 记忆过期 | ✅ (project_end) | ❌ | ❌ | **缺失** |

### 1.4 技能系统

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| 技能注册 | ✅ | ✅ | ✅ | - |
| 技能发现 | ✅ (recursive) | ✅ (recursive) | ✅ | - |
| 内置技能 | ✅ | ✅ | ✅ | - |
| 子代理模式 | ✅ (runAs: subagent) | ✅ | ❌ | **缺失** |
| 技能固定 | ✅ (skill-pin) | ❌ | ❌ | **缺失** |
| 技能市场 | ❌ | ✅ (registry) | ❌ | **缺失** |
| Claude兼容 | ✅ (.claude/skills/) | ✅ | ❌ | **缺失** |

### 1.5 命令系统

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| /help | ✅ | ✅ | ✅ | - |
| /clear | ✅ | ✅ | ✅ | - |
| /status | ✅ | ✅ | ✅ | - |
| /exit | ✅ | ✅ | ✅ | - |
| /new | ✅ | ✅ | ❌ | **缺失** |
| /save | ✅ | ✅ | ❌ | **缺失** |
| /load | ✅ | ✅ | ❌ | **缺失** |
| /compact | ✅ | ✅ | ❌ | **缺失** |
| /undo | ✅ | ✅ | ❌ | **缺失** |
| /redo | ✅ | ✅ | ❌ | **缺失** |
| /skill | ✅ | ✅ | ❌ | **缺失** |
| /memory | ✅ | ✅ | ❌ | **缺失** |
| /config | ✅ | ✅ | ❌ | **缺失** |
| /mcp | ✅ | ✅ | ❌ | **缺失** |
| /hooks | ✅ | ✅ | ❌ | **缺失** |
| /replay | ✅ | ❌ | ❌ | **缺失** |
| /diff | ✅ | ✅ | ❌ | **缺失** |
| /restore | ✅ | ✅ | ❌ | **缺失** |

### 1.6 钩子系统

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| PreToolUse | ✅ | ✅ | ❌ | **缺失** |
| PostToolUse | ✅ | ✅ | ❌ | **缺失** |
| UserPromptSubmit | ✅ | ✅ | ❌ | **缺失** |
| Stop | ✅ | ✅ | ❌ | **缺失** |
| SessionStart | ❌ | ✅ | ❌ | **缺失** |
| SessionEnd | ❌ | ✅ | ❌ | **缺失** |
| ShellEnv | ❌ | ✅ | ❌ | **缺失** |
| 条件过滤 | ✅ (match) | ✅ (HookCondition) | ❌ | **缺失** |
| 超时控制 | ✅ | ✅ | ❌ | **缺失** |
| 后台执行 | ❌ | ✅ | ❌ | **缺失** |

### 1.7 安全系统

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| 审批系统 | ✅ (PauseGate) | ✅ (ApprovalRequirement) | ❌ | **缺失** |
| 沙箱 | ❌ | ✅ (Seatbelt/Landlock) | ❌ | **缺失** |
| 网络策略 | ❌ | ✅ (NetworkPolicy) | ❌ | **缺失** |
| 权限控制 | ✅ (tool permissions) | ✅ | ❌ | **缺失** |
| 审计日志 | ❌ | ✅ (audit.log) | ❌ | **缺失** |

### 1.8 会话管理

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| 会话保存 | ✅ (JSONL) | ✅ (SQLite) | ✅ | - |
| 会话恢复 | ✅ | ✅ | ❌ | **缺失** |
| 会话导入 | ✅ (Claude/Codex) | ❌ | ❌ | **缺失** |
| 会话导出 | ✅ | ❌ | ❌ | **缺失** |
| 检查点 | ✅ | ✅ | ❌ | **缺失** |
| 快照 | ❌ | ✅ (side-git) | ❌ | **缺失** |
| 离线队列 | ❌ | ✅ | ❌ | **缺失** |

### 1.9 MCP支持

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| MCP客户端 | ✅ | ✅ | ❌ | **缺失** |
| stdio传输 | ✅ | ✅ | ❌ | **缺失** |
| SSE传输 | ✅ | ✅ | ❌ | **缺失** |
| HTTP传输 | ✅ | ✅ | ❌ | **缺失** |
| 工具注册 | ✅ | ✅ | ❌ | **缺失** |
| 资源访问 | ✅ | ✅ | ❌ | **缺失** |

### 1.10 语义索引

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| 语义搜索 | ✅ (Ollama) | ❌ | ❌ | **缺失** |
| 代码索引 | ✅ | ❌ | ❌ | **缺失** |
| 嵌入向量 | ✅ | ❌ | ❌ | **缺失** |

### 1.11 Web仪表板

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| Dashboard | ✅ (SPA) | ❌ | ❌ | **缺失** |
| REST API | ✅ | ✅ (Runtime API) | ❌ | **缺失** |
| SSE事件 | ✅ | ✅ | ❌ | **缺失** |

### 1.12 国际化

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| i18n | ✅ (EN/zh-CN/de/ru) | ✅ (多语言) | ❌ | **缺失** |
| 本地化 | ✅ | ✅ | ❌ | **缺失** |

### 1.13 遥测统计

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| 使用统计 | ✅ (SessionStats) | ✅ | ❌ | **缺失** |
| Token统计 | ✅ | ✅ | ❌ | **缺失** |
| 成本统计 | ✅ | ✅ | ❌ | **缺失** |
| 性能统计 | ✅ | ✅ | ❌ | **缺失** |

### 1.14 子代理系统

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| 子代理 | ✅ (runAs: subagent) | ✅ (SubAgentManager) | ❌ | **缺失** |
| 代理通信 | ✅ | ✅ (Mailbox) | ❌ | **缺失** |
| 代理生命周期 | ✅ | ✅ | ❌ | **缺失** |

### 1.15 任务管理

| 功能 | DeepSeek-Reasonix | CodeWhale | Minimum | 差距 |
|------|-------------------|-----------|---------|------|
| 后台任务 | ❌ | ✅ (TaskManager) | ❌ | **缺失** |
| 任务队列 | ❌ | ✅ | ❌ | **缺失** |
| 任务状态 | ❌ | ✅ | ❌ | **缺失** |
| 任务恢复 | ❌ | ✅ | ❌ | **缺失** |

---

## 二、缺失功能优先级

### 🔴 高优先级（核心功能）

| # | 功能 | 说明 | 工作量 |
|---|------|------|--------|
| 1 | **Slash Commands** | /new, /save, /load, /compact, /undo, /redo, /skill, /memory, /config | 2天 |
| 2 | **Hooks System** | PreToolUse, PostToolUse, UserPromptSubmit, Stop | 2天 |
| 3 | **Approval System** | 危险操作审批确认 | 1天 |
| 4 | **Session Restore** | 会话恢复和检查点 | 2天 |
| 5 | **Storm Detection** | 工具调用风暴检测 | 1天 |
| 6 | **Runtime Memory** | 运行时记忆（AppendOnlyLog） | 1天 |

### 🟡 中优先级（增强功能）

| # | 功能 | 说明 | 工作量 |
|---|------|------|--------|
| 7 | **MCP Support** | Model Context Protocol 客户端 | 3天 |
| 8 | **Sub-agent System** | 子代理系统 | 3天 |
| 9 | **Capacity Controller** | 容量控制器 | 2天 |
| 10 | **Transcript/Replay** | 对话记录和回放 | 2天 |
| 11 | **Telemetry** | 使用统计和成本追踪 | 1天 |
| 12 | **Network Policy** | 网络策略控制 | 1天 |
| 13 | **Audit Log** | 审计日志 | 1天 |

### 🟢 低优先级（扩展功能）

| # | 功能 | 说明 | 工作量 |
|---|------|------|--------|
| 14 | **Semantic Index** | 语义向量索引 | 3天 |
| 15 | **Dashboard** | Web 仪表板 | 5天 |
| 16 | **Runtime API** | HTTP/SSE API | 3天 |
| 17 | **i18n** | 国际化 | 2天 |
| 18 | **Task Manager** | 后台任务管理 | 3天 |
| 19 | **Sandbox** | 沙箱安全 | 3天 |
| 20 | **LSP Integration** | LSP 集成 | 2天 |

---

## 三、建议实现顺序

### Phase 1: 核心命令和钩子（1周）
```
Week 1:
├── Day 1-2: Slash Commands (/new, /save, /load, /compact, /undo, /redo)
├── Day 3-4: Hooks System (PreToolUse, PostToolUse, UserPromptSubmit, Stop)
├── Day 5: Approval System + Storm Detection
└── Day 6-7: Session Restore + Runtime Memory
```

### Phase 2: MCP和子代理（1周）
```
Week 2:
├── Day 1-3: MCP Client (stdio, SSE, HTTP)
├── Day 4-5: Sub-agent System
├── Day 6: Capacity Controller
└── Day 7: Transcript/Replay
```

### Phase 3: 增强功能（1周）
```
Week 3:
├── Day 1: Telemetry
├── Day 2: Network Policy + Audit Log
├── Day 3-4: Task Manager
├── Day 5: i18n
└── Day 6-7: Testing + Documentation
```

### Phase 4: 高级功能（可选）
```
Week 4+:
├── Semantic Index
├── Dashboard
├── Runtime API
├── Sandbox
└── LSP Integration
```

---

## 四、代码量估算

| 类别 | 现有代码 | 需要新增 | 总计 |
|------|----------|----------|------|
| 核心模块 | ~3600行 | ~2000行 | ~5600行 |
| 命令系统 | ~100行 | ~800行 | ~900行 |
| 钩子系统 | 0行 | ~500行 | ~500行 |
| MCP支持 | 0行 | ~1000行 | ~1000行 |
| 子代理 | 0行 | ~800行 | ~800行 |
| 其他功能 | 0行 | ~2000行 | ~2000行 |
| **总计** | **~3700行** | **~7100行** | **~10800行** |

---

## 五、快速实现建议

### 5.1 Slash Commands（最快实现）

```typescript
// src/commands/SlashCommands.ts
export class SlashCommands {
  private commands: Map<string, CommandHandler> = new Map();

  register(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }

  async execute(input: string, context: CommandContext): Promise<string> {
    if (!input.startsWith('/')) {
      return 'Not a command';
    }

    const [command, ...args] = input.slice(1).split(' ');
    const handler = this.commands.get(command);

    if (!handler) {
      return `Unknown command: /${command}`;
    }

    return handler.execute(args, context);
  }
}

// 注册命令
commands.register('new', new NewSessionCommand());
commands.register('save', new SaveSessionCommand());
commands.register('load', new LoadSessionCommand());
commands.register('compact', new CompactCommand());
commands.register('undo', new UndoCommand());
commands.register('redo', new RedoCommand());
commands.register('skill', new SkillCommand());
commands.register('memory', new MemoryCommand());
commands.register('config', new ConfigCommand());
```

### 5.2 Hooks System（快速实现）

```typescript
// src/hooks/HookManager.ts
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop';

export interface Hook {
  event: HookEvent;
  command: string;
  timeout?: number;
}

export class HookManager {
  private hooks: Map<HookEvent, Hook[]> = new Map();

  register(hook: Hook): void {
    const hooks = this.hooks.get(hook.event) || [];
    hooks.push(hook);
    this.hooks.set(hook.event, hooks);
  }

  async execute(event: HookEvent, context: any): Promise<void> {
    const hooks = this.hooks.get(event) || [];

    for (const hook of hooks) {
      await this.runHook(hook, context);
    }
  }

  private async runHook(hook: Hook, context: any): Promise<void> {
    // 执行shell命令
    const { exec } = await import('child_process');
    // ...
  }
}
```

### 5.3 Approval System（快速实现）

```typescript
// src/approval/ApprovalManager.ts
export interface ApprovalRequest {
  tool: string;
  args: Record<string, any>;
  risk: 'low' | 'medium' | 'high';
}

export class ApprovalManager {
  async requestApproval(request: ApprovalRequest): Promise<boolean> {
    if (request.risk === 'low') {
      return true;
    }

    // 在TUI中显示确认对话框
    return this.showConfirmation(request);
  }

  private async showConfirmation(request: ApprovalRequest): Promise<boolean> {
    // 使用readline或ink显示确认
    // ...
  }
}
```

---

**文档版本**: 1.0.0  
**最后更新**: 2026-05-27