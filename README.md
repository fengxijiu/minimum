<p align="center">
  <img src="docs/logo.png" alt="Minimum" width="120" />
</p>

<h1 align="center">Minimum</h1>

<p align="center">
  <strong>MiMo Coding Experience Optimization</strong><br/>
  针对 MiMo 模型的终端编码助手 · TypeScript + Ink TUI
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node >= 22" />
  <img src="https://img.shields.io/badge/typescript-5.6+-blue" alt="TypeScript 5.6+" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
  <img src="https://img.shields.io/badge/tests-798+-brightgreen" alt="Tests" />
</p>

---

## 目录

- [简介](#简介)
- [截图](#截图)
- [快速开始](#快速开始)
- [配置](#配置)
- [TUI 交互](#tui-交互)
- [运行模式](#运行模式)
  - [单 Agent 模式](#单-agent-模式)
  - [W0–W4 流水线模式](#w0w4-流水线模式)
  - [记忆系统](#记忆系统)
- [内置工具](#内置工具)
- [TUI 命令参考](#tui-命令参考)
- [架构设计](#架构设计)
  - [目录结构](#目录结构)
  - [核心模块说明](#核心模块说明)
  - [数据流](#数据流)
- [开发指南](#开发指南)
- [测试](#测试)
- [许可证](#许可证)

---

## 简介

**Minimum** 是一个运行在终端中的 AI 编码助手，专为小米 MiMo 大模型设计。它将 MiMo 的推理能力与完整的开发工具链集成，提供从对话式编码到多 Agent 协作流水线的全栈开发体验。

**核心特性：**

- 🖥️ **沉浸式终端 UI** — 基于 Ink (React for CLI) 构建，三栏布局：聊天流 + 文件侧栏 + 状态栏
- 🤖 **双模式运行** — 单 Agent 快速对话 / W0–W4 多 Persona 流水线编排
- 🔧 **8 种内置工具** — 文件读写、代码搜索、Shell 执行、Git 操作、Web 抓取等
- 🧠 **记忆治理** — 项目级记忆系统，跨会话持久化知识，fence-aware 合并
- 🛡️ **三级审批** — read-only / auto-edit / full-auto，安全可控
- 📊 **实时可观测** — Token 用量、费用估算、工具进度、Plan 步骤可视化

---

## 快速开始

### 1. 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 22 | 引擎和 TUI 均需 |
| npm | 任意版本 | 随 Node.js 安装 |

### 2. 安装与构建

**一键构建（推荐）：**

```bash
git clone https://github.com/fengxijiu/minimum.git
cd minimum
scripts/build-all.sh
```

`build-all.sh` 会按依赖顺序构建引擎 → TUI，然后通过 `npm link` 注册全局 `minimum` 命令。

可用选项：
```bash
scripts/build-all.sh            # 完整构建 + 全局注册
scripts/build-all.sh --no-link  # 仅构建，不注册全局命令
scripts/build-all.sh --clean    # 清理旧产物后重新构建
```

**手动构建：**

```bash
# 1. 构建引擎
npm install
npm run build

# 2. 构建 TUI
cd tui
npm install
npm run build
cd ..

# 3. 注册全局命令（可选）
npm link
```

### 3. 配置 API Key

```bash
export MIMO_API_KEY=your_key_here
```

Token Plan 用户（`tp-` 开头的 key 会自动选择 Token Plan 端点）：

```bash
export MIMO_API_KEY=tp-your_key_here
```

### 4. 启动

```bash
minimum
# 或直接运行
node bin/minimum-ink.js
```

> 💡 未设置 `MIMO_API_KEY` 时自动进入 **mock 模式**，TUI 正常启动，回复为占位文本。适合体验 UI 或开发调试。

---

## 配置

### 配置文件层级

配置按优先级从高到低合并（项目配置覆盖全局配置）：

| 层级 | 路径 | 说明 |
|------|------|------|
| 项目级 | `.minimum/config.json` | 项目专属配置，`/init` 命令自动生成 |
| 全局级 | `~/.minimum/config.json` | 所有项目共享的默认配置 |

### 配置文件格式

```json
{
  "apiKey": "your_key_here",
  "baseUrl": "https://api.xiaomimimo.com/v1",
  "defaultModel": "mimo-v2.5-pro",
  "approvalMode": "auto-edit",
  "editMode": "auto"
}
```

### 可用模型

| 模型 | 说明 |
|------|------|
| `mimo-v2.5-pro` | 专业版 — Agentic 长上下文一致性更强（推荐） |
| `mimo-v2.5` | 标准版 — 支持图片理解，多模态能力 |
| `mimo-omni` | 全能版 — 多模态全能 |

### API 端点

| 区域 | URL |
|------|-----|
| 默认（中国） | `https://api.xiaomimimo.com/v1` |
| 新加坡 | `https://token-plan-sgp.xiaomimimo.com/v1` |
| 欧洲 | `https://token-plan-ams.xiaomimimo.com/v1` |

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `MIMO_API_KEY` | MiMo API 认证密钥 | 未设置（Mock 模式） |
| `MIMO_BASE_URL` | API 端点地址 | `https://api.xiaomimimo.com/v1` |
| `MINIMUM_ENABLE_SHELL` | 启用 Shell 工具执行 | `0`（禁用） |
| `MINIMUM_TELEMETRY` | 启用遥测数据收集 | `1`（启用） |

---

## TUI 交互

### 界面布局

TUI 采用 **Zone 隔离渲染** 架构，各区域独立刷新：

```
┌─ TitleBar ─────────────────────────────────────────────┐
│ 项目名 · 分支名 · 模式指示器                              │
├─ PlanStrip ────────────────────────────────────────────┤
│ [✓] Step 1  [▶] Step 2  [ ] Step 3  [ ] Step 4        │
├─ PipelinePanel (仅 /orchestrate 模式) ─────────────────┤
│ W0 ████░░░ 1.2s  W1 ██░░░░░ 0.5s  W2/3 ░░░░░░░  --   │
├─ ChatStream ──────────────────────────────────────────┤
│ ● Agent: I'll help you set up the project...           │
│ ┌─ Tool ──────────────────────────────────────────┐   │
│ │ ▶ run  npm init -y                     0.3s  ✓  │   │
│ └─────────────────────────────────────────────────┘   │
├───────────────────────────────────────────────────────┤
│ ▸ Type a message or / for commands...                  │
├─ StatusBar ───────────────────────────────────────────┤
│ mimo-v2.5-pro │ 1,234 tok │ $0.003 │ auto-edit        │
└───────────────────────────────────────────────────────┘
```

### 输入交互

| 操作 | 说明 |
|------|------|
| 直接输入文字 | 发送给 Agent 对话 |
| `/` | 打开命令面板（模糊搜索 + 匹配高亮） |
| `@` | 打开文件选择器（basename 优先匹配，路径分层着色） |
| `↑` / `↓` | 面板内选择 / 浏览输入历史 |
| `Tab` | 命令/文件补全；无面板时切换 agent/chat 模式 |
| `Shift+Tab` | 循环切换编辑模式 |
| `Esc` | 关闭面板 / 清空输入 |
| `Ctrl+U` | 清空当前输入 |
| `Alt+S` | 交换暂存内容与当前输入 |
| `Ctrl+R` | 切换 verbose 模式 |
| `Ctrl+P` / `Ctrl+N` | 会话内输入历史前/后 |
| `Ctrl+D` | 退出 |

---

## 运行模式

Minimum 提供三种核心能力：**单 Agent 对话**处理日常编码任务，**W0–W4 流水线**编排复杂多角色协作，**记忆系统**实现跨会话知识持久化。三者相互独立又紧密协作——流水线的 W4 阶段会自动将成果写入记忆，记忆又为后续对话和流水线提供上下文。

### 单 Agent 模式

默认模式。适合交互式对话、小规模代码修改、快速问答。

**工作流程：**

1. 用户输入消息 → 发送给 MiMo 模型
2. 模型返回文本 + 工具调用请求
3. 引擎执行工具（受审批策略控制）
4. 工具结果回传给模型，继续推理
5. 循环直到模型输出最终回复

**核心机制：**

- **流式输出** — 100ms 缓冲刷新，实时看到模型推理过程
- **并行工具执行** — 只读工具批量并发（默认最多 3 个），加速信息收集
- **工具结果截断** — 单个工具结果上限 32K 字符，防止上下文溢出
- **消息历史修复** — 自动检测并修复不完整的消息序列（healing）
- **编辑快照** — 每次文件编辑自动创建快照，支持 `/undo` 回滚
- **Plan 可视化** — 模型输出的步骤计划实时渲染为进度条

**审批模式：**

| 模式 | 说明 |
|------|------|
| `read-only` | 仅允许读取操作，所有写入/执行需手动确认 |
| `auto-edit` | 自动批准文件编辑，Shell 执行需确认（推荐） |
| `full-auto` | 全自动，所有操作无需确认 |

**编辑模式：**

| 模式 | 说明 |
|------|------|
| `review` | 每次编辑前显示 diff 预览 |
| `auto` | 自动应用编辑，不中断工作流 |
| `yolo` | 自动应用，跳过所有验证 |

### W0–W4 流水线模式

通过 `/orchestrate <需求>` 启动。适合复杂特性开发、多文件重构、需要多角色协作的任务。

与单 Agent 模式不同，流水线将一个大任务拆解为多个子任务，分配给不同 Persona 并发执行，通过依赖图保证执行顺序，最终由 master_planner 汇总结果。整个过程在 TUI 的 `PipelinePanel` 中实时展示各阶段的进度和耗时。

#### 流水线阶段

```
用户需求
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│ W0   TaskCompiler                                               │
│      master_planner 读取项目记忆，分析需求，生成粗粒度任务            │
│      输出：TaskContract[]（含依赖关系、Persona 分配、验收标准）       │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ W0.5 Refiner                                                    │
│      master_planner 二次精化合约：补全缺失字段、校验路径策略          │
│      ContractValidator 检查完整性，不通过则要求重编译                │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ W1   感知波（并发）                                               │
│      vision         — 需求理解、UI/UX 设计分析                     │
│      repo_scout     — 仓库结构扫描、依赖图谱、代码风格识别            │
│      context_builder — 聚合前两者产出，构建 ContextPack             │
│      以上三个 Persona 均为只读，并发执行无文件冲突                    │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ W2/3 实现+校验波（并发，可多轮）                                    │
│      code_executor  — 根据 ContextPack 实现代码修改               │
│      test_writer    — 编写测试用例                                │
│      test_runner    — 执行测试并报告结果                           │
│      runtime_debug  — 运行时调试、错误诊断                         │
│      reviewer       — 代码审查、质量检查                           │
│      docs           — 文档编写、注释补充                           │
│      TaskGraph 保证同一 Wave 内并发任务的文件路径不冲突               │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ W4   Finalize                                                   │
│      master_planner 汇总所有 TaskResult                          │
│      MemoryGovernor 执行记忆治理（详见「记忆系统」）                 │
│      清理 staging 暂存区                                         │
│      输出：FinalizeReport（成功/失败/记忆变更摘要）                  │
└─────────────────────────────────────────────────────────────────┘
```

#### 10 个 Persona 角色

每个 Persona 有独立的模型选择、工具白名单、路径策略和输出 Schema：

| 角色 | 类型 | 职责 | 可写 | 独占 Wave | 最大并发 |
|------|------|------|------|-----------|---------|
| `master_planner` | master | 任务编排、合约生成、结果终结 | — | — | 1 |
| `vision` | worker | 需求分析、UI/UX 设计建议 | ✗ | 否 | 1 |
| `repo_scout` | worker | 仓库结构扫描、依赖分析 | ✗ | 否 | 1 |
| `context_builder` | worker | 上下文包构建、信息聚合 | ✗ | 否 | 1 |
| `code_executor` | worker | 代码实现、文件修改 | ✓ | 否 | 3 |
| `test_writer` | worker | 测试用例编写 | ✓ | 否 | 2 |
| `test_runner` | worker | 测试执行与结果分析 | ✗ | 否 | 1 |
| `runtime_debug` | worker | 运行时调试、错误诊断 | ✓ | 是 | 1 |
| `reviewer` | worker | 代码审查、质量检查 | ✗ | 否 | 1 |
| `docs` | worker | 文档编写、注释补充 | ✓ | 否 | 1 |

**路径安全策略：**

- `canWrite: false` 的 Persona（vision / repo_scout / reviewer）被 `PathPolicyEnforcer` 全局禁止写入
- `alwaysAllowedGlobs` — 每个 Persona 只能写入自己的 `_staging/<taskId>/` 目录
- `forbiddenGlobs` — 禁止任何 Persona 修改 `.minimum/memory.md` 等核心文件（由 MemoryGovernor 专管）

#### 并发调度机制

`WaveScheduler` 基于 DAG 拓扑排序将任务划分为多个 Wave：

- 同一 `parallelGroup` 内的任务并发执行
- `TaskGraph` 保证并发任务的 `allowedGlobs` 不相交（无文件冲突）
- `soloPerWave` 标记的任务（如 `runtime_debug`）独占整个 Wave，其他任务等它完成后再启动
- `maxConcurrent` 限制单个 Wave 内的最大并发数
- 上游任务全部完成后，下游任务才会被调度

#### TaskContract 合约

每个任务在执行前必须有完整的 `TaskContract`，由 `ContractValidator` 校验：

```typescript
interface TaskContract {
  taskId: string;           // 全局唯一，如 "T-C1-2"
  phase: string;            // 所属阶段，如 "P3-frontend"
  epicId: string;           // 所属 Epic
  personaId: PersonaId;     // 执行者角色
  objective: string;        // 人类可读的任务目标
  inputs: TaskInputs;       // 用户目标 + 上下文包 + 上游产物
  pathPolicy: TaskPathPolicy; // 路径访问控制
  acceptance: string[];     // 验收标准列表
  outputSchema: OutputSchema; // 期望输出格式
  parallelGroup: string;    // 并发分组标识
  dependsOn: string[];      // 上游任务 ID 列表
  abortOnConflict: boolean; // 路径冲突时是否中止
}
```

### 记忆系统

记忆系统是 Minimum 的核心差异化能力。它让 Agent 能够跨会话积累项目知识，避免每次对话都从零开始理解代码库。

#### 三层记忆架构

```
┌─────────────────────────────────────────────────────────────┐
│                   项目记忆 (ProjectMemory)                   │
│    .minimum/memory.md — 跨会话持久化的项目知识库                │
│    由 MemoryGovernor 管理，fence-aware 合并，不破坏代码块       │
├─────────────────────────────────────────────────────────────┤
│                   会话记忆 (SessionMemory)                   │
│    当前会话内的对话历史和上下文                                 │
│    会话结束时可选择性沉淀到项目记忆                              │
├─────────────────────────────────────────────────────────────┤
│                   运行时记忆 (RuntimeMemory)                  │
│    内存中的临时状态：工具执行结果、编辑快照等                       │
│    会话结束后清除                                              │
└─────────────────────────────────────────────────────────────┘
```

#### 记忆治理流程（W4 阶段）

流水线的 W4 Finalize 阶段会自动执行记忆治理：

```
所有 TaskResult
  │
  ▼
MemoryGovernor 收集 MemoryCandidate[]
  │
  ▼
master_planner 对每个候选做出决策：
  ├── merge   → 追加到 .minimum/memory.md（带来源标记）
  ├── archive → 移动到 _archive/ 目录
  └── reject  → 丢弃
  │
  ▼
MemoryStaging 清理暂存区
```

**关键设计：**

- **Fence-aware 合并** — 写入记忆时不会破坏已有的代码块围栏（` ``` `），精确插入到正确位置
- **来源追溯** — 每条记忆条目携带 `source_task`、`persona`、`related_files` 元数据
- **Token 预算加载** — `MemoryLoader` 按 token 预算加载记忆，W0 编排时不会超出上下文窗口
- **相关性排序** — `ContextPackBuilder` 为每个 Worker 按相关性排序注入上下文，确保关键信息优先
- **评分淘汰** — `MemoryScorer` 对记忆条目评分，低分条目在后续合并中被淘汰

#### 记忆文件格式

`.minimum/memory.md` 示例：

```markdown
## 项目架构

- 使用 Express.js + TypeScript 构建 REST API
- 数据库：PostgreSQL，通过 Prisma ORM 访问
<!-- source: T-C1-2, persona: repo_scout, files: [prisma/schema.prisma] -->

## 编码规范

- 错误处理统一使用 AppError 类（src/errors.ts）
- 所有路由需添加 Joi 输入验证
<!-- source: T-C2-1, persona: reviewer, files: [src/routes/*.ts] -->

## 已知问题

- JWT token 过期逻辑需要 refresh token 支持
<!-- source: T-C3-1, persona: runtime_debug, files: [src/auth/jwt.ts] -->
```

#### 记忆命令

| 命令 | 说明 |
|------|------|
| `/memory` | 显示项目记忆文件路径和大小 |
| `/compact` | 查看上下文压缩状态，了解记忆占用 |
| `/init` | 初始化项目时自动创建 `.minimum/` 目录结构 |

---

## 内置工具

| 工具 | 类别 | 说明 |
|------|------|------|
| `read_file` | 读取 | 读取文件内容，支持行范围、编码指定 |
| `edit_file` | 编辑 | SEARCH/REPLACE 块编辑 |
| `apply_patch` | 编辑 | 安全的 search/replace hunk 编辑，防止盲目覆写 |
| `write_file` | 编辑 | 创建或覆写文件 |
| `exec_shell` | 执行 | 执行 Shell 命令（需 `MINIMUM_ENABLE_SHELL=1`） |
| `grep` | 搜索 | 代码搜索（正则匹配） |
| `glob` | 搜索 | 文件名模式匹配 |
| `git` | 版本控制 | Git 操作封装 |
| `web_fetch` | 网络 | 网页内容抓取 |
| `todo` | 任务 | 待办事项管理 |

**安全策略：**

- `PathPolicyEnforcer` — 基于 Persona 的路径访问控制（glob 模式匹配）
- `ToolAllowlistEnforcer` — 工具白名单/黑名单过滤
- Shell 工具默认关闭，需显式启用

---

## TUI 命令参考

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
| `/compact` | | 上下文压缩状态 |
| `/undo` | | 撤销最后一次暂存编辑 |
| `/redo` | | 重做已撤销的编辑 |
| `/memory` | `mem` | 显示项目记忆路径 |
| `/plan` | | 显示当前计划进度 |
| `/mode [agent\|chat]` | | 切换模式 |
| `/permission [mode]` | `perm`, `approval`, `appr` | 权限模式：`read-only` / `auto-edit` / `full-auto` |
| `/editmode [mode]` | | 编辑模式：`review` / `auto` / `yolo` |
| `/verbose` | `v` | 切换详细输出（也可 Ctrl+R） |
| `/run <cmd>` | | 运行 shell 命令（先弹权限确认） |
| `/mcp` | | 显示 MCP Server 状态 |
| `/status` | | 显示会话状态摘要 |
| `/tools` | | 列出可用工具 |
| `/model` | | 显示当前模型 |
| `/config` | `cfg` | 显示配置信息 |
| `/init` | | 在当前项目初始化配置 |
| `/help` | `?` | 显示快捷键帮助 |
| `/quit` | `exit` `q` | 退出（也可 Ctrl+D） |

---

## 架构设计

### 目录结构

```
minimum/
├── bin/                        # CLI 入口
│   └── minimum-ink.js          # 主入口，spawn tui/dist/cli.js
│
├── src/                        # 引擎层（框架无关，可被任意前端消费）
│   ├── index.ts                # 统一 re-export
│   │
│   ├── bridge/                 # 事件桥接
│   │   ├── EngineBridge.ts     # MiMoLoop → UiEvent 规范化流
│   │   └── PipelineBridge.ts   # MiMoPipeline → UiEvent 规范化流
│   │
│   ├── loop/                   # 单 Agent 推理循环
│   │   ├── MiMoLoop.ts         # 核心循环：stream → tool → loop
│   │   ├── healing.ts          # 消息历史修复
│   │   ├── messages.ts         # 消息构建
│   │   ├── ReadTracker.ts      # 读取/编辑工具追踪
│   │   └── SnapshotManager.ts  # 编辑快照管理
│   │
│   ├── orchestration/          # W0–W4 多 Persona 流水线
│   │   ├── MiMoPipeline.ts     # 主编排器
│   │   ├── TaskCompiler.ts     # W0: 需求 → 带依赖图的任务 DAG
│   │   ├── TaskGraph.ts        # DAG 构建与拓扑排序
│   │   ├── TaskContract.ts     # 任务合约定义
│   │   ├── ContractValidator.ts# 合约完整性校验
│   │   ├── Refiner.ts          # W0.5: 二次精化
│   │   ├── WaveScheduler.ts    # 并发波次调度
│   │   ├── TaskRunner.ts       # 单任务执行
│   │   └── ClientAdapters.ts   # 流式客户端适配
│   │
│   ├── personas/               # 10 个固定角色定义
│   │   └── Persona.ts          # PersonaId / PathPolicy / Parallelism
│   │
│   ├── memory/                 # 项目记忆系统
│   │   ├── ProjectMemory.ts    # 项目级记忆
│   │   ├── RuntimeMemory.ts    # 运行时记忆
│   │   ├── SessionMemory.ts    # 会话级记忆
│   │   ├── MemoryStore.ts      # 记忆存储
│   │   └── governance/         # 记忆治理
│   │       ├── MemoryGovernor.ts    # W4 合并决策执行
│   │       ├── MemoryLoader.ts      # 按 token 预算加载
│   │       ├── ContextPackBuilder.ts# Worker 上下文注入
│   │       ├── MemoryScorer.ts      # 记忆评分
│   │       ├── MemoryStaging.ts     # 暂存区管理
│   │       ├── MemoryManifest.ts    # 记忆清单
│   │       └── MemoryInspector.ts   # 记忆检查
│   │
│   ├── tools/                  # 内置工具
│   │   ├── ToolRegistry.ts     # 工具注册中心
│   │   ├── filesystem/         # read_file / edit_file / apply_patch / write_file
│   │   ├── shell/              # exec_shell
│   │   ├── search/             # grep / glob
│   │   ├── git/                # git 操作
│   │   ├── web/                # web_fetch
│   │   ├── todo/               # todo 管理
│   │   └── policy/             # PathPolicyEnforcer / ToolAllowlistEnforcer
│   │
│   ├── clients/                # MiMo API 客户端
│   │   └── MiMoClient.ts       # 流式 Chat Completion
│   │
│   ├── approval/               # 审批流程
│   │   ├── ApprovalManager.ts  # 审批管理器
│   │   └── types.ts            # ApprovalMode / Request / Response
│   │
│   ├── config/                 # 配置管理
│   │   ├── MiMoConfig.ts       # 配置类型
│   │   ├── loadMiMoConfig.ts   # 配置加载与合并
│   │   └── createMiMoStack.ts  # 全栈初始化
│   │
│   ├── capacity/               # 容量控制（token 预算、上下文窗口）
│   ├── context/                # 上下文管理（摘要、关键信息提取）
│   ├── index/                  # 语义索引（Embedding + Chunker）
│   ├── session/                # 会话管理（保存/加载/检查点）
│   ├── transcript/             # 对话记录持久化
│   ├── commands/               # 命令系统
│   ├── skills/                 # 技能系统
│   ├── hooks/                  # 生命周期钩子
│   ├── mcp/                    # MCP 协议支持
│   ├── lsp/                    # LSP 协议集成
│   ├── subagent/               # 子代理系统
│   ├── tasks/                  # 任务队列
│   ├── telemetry/              # 遥测统计
│   ├── repair/                 # 工具调用修复（StormBreaker）
│   ├── validators/             # 代码验证器
│   ├── completeness/           # 完整性检查
│   ├── iteration/              # 迭代控制
│   ├── types/                  # 全局类型定义
│   ├── utils/                  # 工具函数
│   └── mocks/                  # Mock 实现
│
├── tui/src/                    # Ink 终端 UI
│   ├── cli.tsx                 # TUI 入口
│   ├── app.tsx                 # 主应用，Zone 隔离渲染
│   ├── engine.ts               # Runner 接口 + createEngineRunner
│   ├── commands.ts             # 命令路由
│   ├── types.ts                # TUI 类型定义
│   ├── files.ts                # 文件扫描
│   ├── seed.ts                 # 初始状态
│   ├── theme.ts                # 主题定义
│   ├── markdown.ts             # Markdown 渲染
│   ├── inputHistory.ts         # 输入历史持久化
│   ├── toolIcon.ts             # 工具图标映射
│   │
│   ├── state/                  # Flux 风格状态机
│   │   ├── events.ts           # 事件定义
│   │   ├── reducer.ts          # 纯函数 reducer
│   │   └── store.ts            # 状态订阅
│   │
│   ├── components/             # UI 组件
│   │   ├── TitleBar.tsx         # 标题栏（项目名 / 分支 / 模式）
│   │   ├── PlanStrip.tsx        # Agent 计划条（步骤级进度）
│   │   ├── PipelinePanel.tsx    # W0–W4 相位条（动画 spinner + 计时）
│   │   ├── ChatStream.tsx       # 消息流
│   │   ├── ContextRail.tsx      # 文件/编辑侧栏
│   │   ├── StatusBar.tsx        # 状态栏（token / 费用 / 模式）
│   │   ├── CommandPalette.tsx   # 命令面板（模糊匹配 + 高亮）
│   │   ├── FilePicker.tsx       # 文件选择器（模糊匹配 + 路径分层着色）
│   │   ├── InputArea.tsx        # 输入区域
│   │   ├── ToolProgress.tsx     # 工具进度（spinner + 计时）
│   │   ├── WelcomeScreen.tsx    # 欢迎屏幕
│   │   ├── ToastBar.tsx         # 通知条
│   │   ├── HelpOverlay.tsx      # 帮助覆盖层
│   │   ├── MarkdownText.tsx     # Markdown 渲染组件
│   │   ├── Prompt.tsx           # 提示组件
│   │   └── atoms.tsx            # 原子组件
│   │
│   └── theme/                  # 主题上下文
│       └── context.tsx
│
├── scripts/                    # 构建脚本
│   ├── build-all.sh            # 一键构建 + 全局注册
│   └── copy-assets.mjs         # 资源文件复制
│
├── tests/                      # 测试
│   ├── unit/                   # 单元测试（239+ tests）
│   └── integration/            # 集成测试
│
├── docs/                       # 文档
├── doc/                        # 设计文档
├── opencode.json               # OpenCode 兼容配置
├── tsconfig.json               # TypeScript 配置
├── tsup.config.ts              # 打包配置
├── vitest.config.ts            # 测试配置
└── jest.config.js              # Jest 配置（兼容层）
```

### 核心模块说明

#### 引擎层 (`src/`)

引擎层是框架无关的核心逻辑，通过 `UiEvent` 规范化事件流与 UI 层解耦。任何前端（Ink TUI / Web / Headless）都可以消费同一套事件流。

**MiMoLoop** — 单 Agent 推理循环的核心：

```
用户输入 → MiMo 模型推理 → [工具调用 → 执行 → 结果回传] → 循环 → 最终回复
                                    ↑___retry on error___↓
```

- 流式输出（100ms 缓冲刷新）
- 并行只读工具批量执行（默认最多 3 个）
- 工具结果截断保护（32K 字符上限）
- 消息历史自动修复（healing）

**MiMoPipeline** — W0–W4 流水线编排的核心：

- `PlannerBridge` 注入 master_planner 的三次 LLM 触点（compile / refine / finalize）
- `WorkerExecutor` 注入 worker 的执行逻辑，便于单元测试 stub
- `PipelineEvent` 事件流驱动 TUI 的 `PipelinePanel` 实时渲染

#### Bridge 层 (`src/bridge/`)

将引擎内部事件（`LoopEvent` / `PipelineEvent`）翻译为前端友好的 `UiEvent`：

```typescript
type UiEvent =
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; name: string; args: string }
  | { kind: 'tool_result'; name: string; ok: boolean; content: string }
  | { kind: 'notice'; text: string; tone: 'info' | 'warn' | 'ok' }
  | { kind: 'error'; text: string }
  | { kind: 'usage'; totalTokens: number; toolCalls: number; steps: number; totalCostUsd: number }
  | { kind: 'plan'; steps: UiPlanStep[] }
  | { kind: 'permission_request'; ... }
  | { kind: 'pipeline'; phase: string; label: string; detail?: string }
  | { kind: 'done'; success: boolean }
  | { kind: 'streaming'; text: string }
  | { kind: 'streaming_reasoning'; text: string }
  | { kind: 'streaming_start' }
  | { kind: 'streaming_end' };
```

### 数据流

```
┌─────────────────────────────────────────────────────────────┐
│                        TUI (Ink)                            │
│  app.tsx → Zone 隔离渲染                                     │
│  state/events.ts → reducer.ts → store.ts → 组件重渲染        │
└───────────────┬─────────────────────────────┬───────────────┘
                │ Runner.send()               │ UiEvent stream
                ▼                             ▲
┌───────────────────────────────┐   ┌─────────────────────────┐
│  EngineBridge (单 Agent)      │   │  PipelineBridge (流水线) │
│  MiMoLoop → LoopEvent → UiEvent│  │  MiMoPipeline → UiEvent │
└───────────────┬───────────────┘   └───────────┬─────────────┘
                │                               │
                ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    MiMo API Client                          │
│  流式 Chat Completion · 工具调用 · Token 统计                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 开发指南

### 开发命令

```bash
# 一键构建
scripts/build-all.sh

# 引擎开发
npm run dev              # tsx 热重载

# TUI 开发
cd tui && npm run dev    # tsx 热重载

# 测试
npm test                 # 运行所有测试
npm run test:watch       # 监听模式
npm run test:coverage    # 覆盖率报告

# 代码质量
npm run lint             # Biome 检查
npm run lint:fix         # 自动修复
npm run format           # 格式化
npm run typecheck        # TypeScript 类型检查
```

### 添加新工具

1. 在 `src/tools/` 下创建新目录
2. 实现工具接口，定义 `name`、`description`、`parameters` 和 `execute()` 方法
3. 在 `src/tools/ToolRegistry.ts` 中注册
4. 在 `tui/src/engine.ts` 的 `KIND` 映射中添加分类
5. 编写单元测试

### 添加新 Persona

1. 在 `src/personas/Persona.ts` 的 `PersonaId` 联合类型中添加
2. 在 `src/personas/` 中注册 Persona 配置（模型、工具白名单、路径策略）
3. 在 `MiMoPipeline.ts` 中定义其所属的 Wave 阶段

### 添加新 TUI 组件

1. 在 `tui/src/components/` 下创建组件
2. 在 `app.tsx` 中添加到对应的 Zone
3. 如需新的事件类型，在 `state/events.ts` 中定义，在 `reducer.ts` 中处理

---

## 测试

```bash
npm test
```

**798+ 个单元测试**，覆盖：

| 模块 | 测试数 | 说明 |
|------|--------|------|
| 工具层 | 76+ | 文件系统、Git、搜索、Web 工具 |
| 审批系统 | 36 | 权限策略、审批流程 |
| 记忆治理 | 24+ | 合并、评分、暂存、清单 |
| 编排器 | 22+ | 任务编排、波次调度 |
| 桥接层 | 44 | EngineBridge / PipelineBridge |
| 技能系统 | 24 | 技能加载、注册 |
| 容量控制 | 19 | Token 预算、上下文窗口 |
| 遥测 | 24 | 事件统计 |
| 子代理 | 22 | 子代理生命周期 |
| TUI 状态机 | — | Flux reducer 全路径覆盖 |
| 钩子系统 | 20 | 生命周期钩子 |

---

## 许可证

[MIT License](LICENSE)

---

<p align="center">
  Made with ❤️ by the MiMo Team
</p>
