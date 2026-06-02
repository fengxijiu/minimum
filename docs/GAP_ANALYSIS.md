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