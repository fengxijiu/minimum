# minimum 后续优化方案

对标 Kimi Code · pi TUI · Claude Code · Codex · OpenCode · DeepSeek-Reasonix · CodeWhale，
给出功能优化与底层设计演进的分层路线图。

## 一、现状盘点（截至本分支）

### 已落地
- **引擎层**：`MiMoLoop` 流式循环、上下文折叠（0.70/0.75）、工具修复、StormBreaker、
  CapacityController 检查点、ReadTracker 先读后写、SnapshotManager 回滚、TscChecker 诊断回灌、
  CompletenessChecker 结构性检查、统一 `MiMoConfig` + `createMiMoStack`
- **客户端**：`MiMoClient` 真实 SSE 流式（fetch + ReadableStream）
- **前端**：Ink TUI 对齐设计原型五状态（welcome / slash 面板 / @file / permission / error）

### 存在但未接通（关键债务）
| 模块 | 状态 | 证据 |
|------|------|------|
| **TUI ↔ 引擎** | 完全断开，Ink TUI 是 mock | `tui/src/` 不 import 引擎，`handleSubmit` 是假回复 |
| **hookManager** | 类型声明但循环从不调用 | `MiMoLoop.ts:26` 声明，仅 `:248` 接了 approval |
| **MCP / subagent** | 模块存在，循环未引用 | `MiMoLoop` 无 mcp/subagent 引用 |
| **LSP** | 仅 CLI 版 tsc，无常驻 server | 只有 `TscChecker.ts` |
| **沙箱** | 无 | 全代码库无 seatbelt/landlock/seccomp |

## 二、对标分析：各工具能补什么

| 参考工具 | 核心可借鉴点 | 对应 minimum 缺口 |
|----------|-------------|-------------------|
| **Claude Code** | hook 生命周期、subagent、MCP、plan mode、TodoWrite、后台任务、权限模式、statusline、CLAUDE.md | hook 未接、subagent 未接、无 plan mode/todo |
| **Codex** | 沙箱执行（seatbelt/landlock）、三档审批（read-only/auto/full-auto）、apply_patch、AGENTS.md、reasoning effort | 无沙箱、审批单一、无 apply_patch |
| **OpenCode** | client/server 拆分、LSP 常驻、多 provider、headless+TUI 共用引擎、会话分享、主题 | TUI 与引擎耦断、无 LSP、无 server |
| **Kimi Code (K2)** | 长程 agentic、重工具链、大上下文、低成本快推理 | 长程任务编排弱、无 token 成本档位 |
| **pi TUI** | 键盘优先、极简 chrome、即时反馈 | TUI 交互已不错，可补流式光标/滚动 |
| **DeepSeek-Reasonix** | cache-first、repair 管道、记忆分层、skill-pin、web 仪表板、语义索引、i18n | 记忆分层浅、无 dashboard、无语义索引 |
| **CodeWhale** | capacity、coherence、快照、沙箱、LSP 诊断、subagent mailbox、审计日志、后台任务 | coherence 状态机缺、无审计、后台任务未接 |

## 三、优化方案（分层）

### P0 — 接通已有能力（最高 ROI，几乎零新模型成本）

**P0-1 把 TUI 接到真引擎（头号债务）**
当前最大的浪费：精致 TUI 和能跑的引擎互不相识。
- 在 `tui/src/app.tsx` 的 `handleSubmit` 接 `createMiMoStack().loop.run()`，
  把 `LoopEvent`（content/reasoning/tool_call/tool_result/diff/capacity/error）映射到现有消息类型
- permission/error 状态由真实 `approvalManager` 事件与工具失败驱动，而非 `/run` 演示
- 参考 OpenCode：抽一层 `EngineBridge`，让 TUI 与 headless 共用同一事件流

**P0-2 激活 hook 系统**
`hookManager` 已声明却从不触发。在 `MiMoLoop` 关键点插桩：
`UserPromptSubmit` → `PreToolUse` →（执行）→ `PostToolUse` → `Stop`。
参考 Claude Code hook 语义（可阻断、可改写、可注入上下文）。

**P0-3 引入 plan mode + TodoWrite**
对标 Claude Code/Codex 的「先规划后执行」。新增只读 plan 模式（禁写工具）+
`TodoList` 工具，TUI 的 PlanStrip 已就绪，直接绑定真实任务步骤。

### P1 — 安全与正确性闭环（对标 Codex / CodeWhale）

**P1-1 沙箱执行**
工具执行进程隔离：Linux 用 landlock + seccomp，macOS 用 seatbelt。
最小可用版：限制 cwd 读写范围 + 默认断网，危险操作走 approval。

**P1-2 三档审批模式**
对标 Codex：`read-only` / `auto-edit`（可改文件、shell 需批准）/ `full-auto`（沙箱内放开）。
把现有 `approvalManager` 升级为模式驱动 + 「always for X」习惯缓存。

**P1-3 常驻 LSP 集成**
把 CLI 版 `TscChecker` 升级为常驻 LSP 客户端（tsserver/pyright），
PostToolUse 后实时诊断回灌 —— 对标 OpenCode/CodeWhale，根治 MiMo 的 Code Defect。

**P1-4 apply_patch 工具**
对标 Codex 的统一 patch 格式，替代裸 write，天然带上下文锚点，降低改错位置概率。

### P2 — 智能体编排（对标 Claude Code / Kimi）

**P2-1 接通 subagent + mailbox**
把 `src/subagent` 接入循环：主 agent 派生只读探查子 agent（并行搜索/分析），
对标 CodeWhale mailbox 做结果回传，保护主上下文窗口。

**P2-2 接通 MCP**
把 `src/mcp` 接入 `ToolRegistry`，支持 stdio/SSE/HTTP，外部工具即插即用。

**P2-3 coherence 状态机 + 成本档位**
对标 CodeWhale CoherenceState：把循环显式建模为 plan→act→verify→repair 状态机；
对标 Kimi 加 reasoning effort / 成本档位（fast/balanced/thorough）。

### P3 — 生态与体验（对标 OpenCode / Reasonix）

- **client/server 拆分**：引擎跑成 daemon，TUI / headless / web 共用（OpenCode 路线）
- **记忆分层 + 语义索引**：append-only log + project/user 记忆 + 向量检索（Reasonix）
- **web dashboard / 会话分享 / replay**：`src/transcript` 已有基础
- **多主题 + i18n**：TUI theme 已抽离，扩成可切换主题
- **AGENTS.md / CLAUDE.md 项目约定**：启动时加载项目级指令

## 四、底层设计演进

```
现在:   TUI(mock) ┄┄✗┄┄ [MiMoLoop → MiMoClient(SSE)]
                          ├ tools(无沙箱)
                          └ hooks/mcp/subagent(未接)

目标:   TUI ┐
        web ├─→ EngineBridge(事件流) ─→ Engine(coherence 状态机)
     headless┘                          ├ ToolHost(沙箱 + 审批模式)
                                        ├ LSP daemon(诊断回灌)
                                        ├ MCP / subagent(mailbox)
                                        └ Memory(分层 + 语义索引)
```

核心原则：**单一事件流**（所有前端共用）、**工具主机隔离**（沙箱 + 审批）、
**状态机显式化**（plan/act/verify/repair 可观测可回滚）。

## 五、优先级建议

先做 **P0**：接通 TUI↔引擎、激活 hook、加 plan/todo —— 这些把"已写但没用起来"的能力变现，
投入小、立刻让产品可用。再做 **P1** 安全与正确性闭环（沙箱 + 审批 + LSP），这是对标
Codex/CodeWhale 的硬门槛。P2/P3 按需推进。

---
**版本**: 1.0.0 ｜ **范围**: minimum 引擎 + TUI
