# Minimum

针对 MiMo 模型的终端编码助手，基于 TypeScript + Ink 构建。  
支持两种运行模式：**单 Agent 循环**（快速对话）和 **W0–W4 多 Persona 流水线**（复杂任务编排）。

---

## 架构

```
minimum/
├── src/                    # 引擎层（框架无关）
│   ├── bridge/             # EngineBridge / PipelineBridge — UiEvent 规范化流
│   ├── loop/               # MiMoLoop 单 Agent 推理循环
│   ├── orchestration/      # W0–W4 多 Persona 流水线
│   │   ├── MiMoPipeline.ts     # 主编排器
│   │   ├── TaskCompiler.ts     # W0 任务拆解
│   │   ├── Refiner.ts          # W0.5 二次精化
│   │   ├── WaveScheduler.ts    # 并发波次调度
│   │   ├── TaskRunner.ts       # 单任务执行
│   │   └── ClientAdapters.ts   # 流式客户端适配
│   ├── personas/           # 10 个固定角色（Planner + 9 Workers）
│   ├── memory/             # 项目记忆 + 治理（staging / manifest / scorer）
│   │   └── governance/         # MemoryGovernor, MemoryLoader, ContextPackBuilder
│   ├── tools/              # read / edit / run / find / git / web + 权限策略
│   ├── approval/           # 审批流程管理
│   └── clients/            # MiMo API 客户端
└── tui/src/                # Ink 终端 UI
    ├── app.tsx             # 主应用，Zone 隔离渲染
    ├── engine.ts           # Runner 接口 + createEngineRunner
    ├── state/              # Flux 风格状态机（events → reducer → AppState）
    └── components/
        ├── PipelinePanel   # W0–W4 相位条（动画 spinner + 计时）
        ├── PlanStrip       # Agent 计划条
        ├── CommandPalette  # 命令面板（模糊匹配 + 高亮）
        ├── FilePicker      # 文件选择器（模糊匹配 + 路径分层高亮）
        ├── ChatStream      # 消息流
        ├── ContextRail     # 文件/编辑侧栏
        └── StatusBar       # 状态栏（token / 费用 / 模式）
```

两种模式共用同一个 `Runner` 接口：

| 模式 | 入口 | 适用场景 |
|------|------|---------|
| 单 Agent | `EngineBridge` → `MiMoLoop` | 交互式对话、小改动 |
| 流水线 | `PipelineBridge` → `MiMoPipeline` | 复杂特性、多文件编排 |

---

## 功能

**TUI 交互**
- 流式输出（100ms 缓冲刷新）
- 命令面板 `/`：模糊匹配 + 匹配字符高亮 + 别名提示 + usage 内联显示
- 文件插入 `@`：basename 优先模糊匹配，路径目录/文件名分层着色
- ↑↓ 选择，⇥ Tab 补全，Esc 关闭面板
- 输入历史持久化（`~/.minimum/input_history`）

**单 Agent 模式**
- 工具调用：read / edit / apply_patch / run / find / git / web_fetch / todo
- 实时工具进度（spinner + 计时）
- 审批模式：read-only / auto-edit / full-auto
- 编辑模式：review / auto / yolo
- Plan 条：步骤级进度可视化

**W0–W4 流水线**（`/orchestrate <需求>`）

```
W0   TaskCompiler  — 需求 → 带依赖图的任务合约
W0.5 Refiner       — 二次精化合约
W1   感知波         — 并发读取/分析任务
W2/3 实现+校验波    — 并发写入/测试任务
W4   Finalize      — 汇总结果，写入项目记忆
```

流水线运行时 PipelinePanel 显示各相位的动画 spinner 和实时耗时；完成后显示每阶段总用时。

**记忆治理**
- `MemoryGovernor`：W4 将候选片段 merge 到 `.minimum/memory.md`（fence-aware，不破坏代码块）
- `MemoryLoader`：按 token 预算加载记忆，供 W0 使用
- `ContextPackBuilder`：为每个 Worker 按相关性排序注入上下文

---

## 环境要求

- Node.js 22+
- npm

---

## 安装与构建

```bash
npm install
npm run build
```

---

## 运行

```bash
node bin/minimum.js
```

---

## 配置

**API Key（必须）**

```bash
export MIMO_API_KEY=your_key_here
```

Token Plan 用户（`tp-` 开头的 key 会自动选择 Token Plan 端点，无需额外设置）：

```bash
export MIMO_API_KEY=tp-your_key_here
```

如需指定其他区域（新加坡 / 欧洲）：

```bash
export MIMO_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1  # 新加坡
export MIMO_BASE_URL=https://token-plan-ams.xiaomimimo.com/v1  # 欧洲
```

也可写入项目配置 `opencode.json` 或全局配置 `~/.minimum/config.json`：

```json
{
  "apiKey": "your_key_here",
  "baseUrl": "https://api.xiaomimimo.com/v1",
  "defaultModel": "mimo-v2.5-pro",
  "approvalMode": "auto-edit"
}
```

**启用 Shell 工具**（默认关闭）

```bash
export MIMO_ENABLE_SHELL=1
```

未设置 `MIMO_API_KEY` 时自动进入 **mock 模式**，TUI 正常启动，回复为占位文本。运行 `/init` 可引导完成首次配置。

---

## TUI 命令

在输入框输入 `/` 弹出命令面板（支持模糊搜索）。

| 命令 | 别名 | 说明 |
|------|------|------|
| `/orchestrate <需求>` | `pipeline` `orch` | 通过 W0–W4 流水线执行复杂任务 |
| `/new` | `reset` | 开启新会话 |
| `/save [name]` | | 保存当前会话 |
| `/load <name>` | | 加载已保存会话 |
| `/sessions` | `ls` | 列出已保存会话 |
| `/clear` | `cls` | 清空聊天记录 |
| `/context` | `ctx` | 显示 token 用量 |
| `/compact` | | 说明上下文压缩状态 |
| `/undo` | | 撤销最后一次暂存编辑 |
| `/redo` | | 重做已撤销的编辑 |
| `/memory` | `mem` | 显示项目记忆路径 |
| `/plan` | | 显示当前计划进度 |
| `/mode [agent\|chat]` | | 切换模式 |
| `/approval [mode]` | `appr` | 审批模式：`read-only` / `auto-edit` / `full-auto` |
| `/editmode [mode]` | | 编辑模式：`review` / `auto` / `yolo` |
| `/verbose` | `v` | 切换详细输出（也可 Ctrl+R） |
| `/run <cmd>` | | 运行 shell 命令（先弹审批） |
| `/mcp` | | 显示 MCP Server 状态 |
| `/status` | | 显示会话状态摘要 |
| `/tools` | | 列出可用工具 |
| `/model` | | 显示当前模型 |
| `/config` | `cfg` | 显示配置信息 |
| `/init` | | 在当前项目初始化配置 |
| `/help` | `?` | 显示快捷键帮助 |
| `/quit` | `exit` `q` | 退出（也可 Ctrl+D） |

**快捷键**

| 按键 | 功能 |
|------|------|
| `Tab` | 命令/文件补全；无面板时切换 agent/chat 模式 |
| `Shift+Tab` | 循环切换编辑模式 |
| `↑` / `↓` | 面板内上下选择；无面板时浏览输入历史 |
| `Ctrl+U` | 清空当前输入（暂存内容） |
| `Alt+S` | 交换暂存内容与当前输入 |
| `Ctrl+R` | 切换 verbose 模式 |
| `Ctrl+P` / `Ctrl+N` | 会话内输入历史前/后 |
| `Esc` | 关闭面板 / 清空输入 / 退出 |

---

## 测试

```bash
npx vitest run
```

798 个单元测试，覆盖工具、权限策略、记忆治理、编排器、TUI 状态机等核心模块。
