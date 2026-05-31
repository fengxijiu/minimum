<p align="center">
  <img src="icon.png" alt="Minimum" width="120" />
</p>

<h1 align="center">Minimum</h1>

<p align="center">
  <strong>MiMo Coding Experience Optimization</strong><br/>
  面向 MiMo 模型的终端编码助手 · TypeScript 引擎 + Ink TUI
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node >= 22" />
  <img src="https://img.shields.io/badge/typescript-5.6+-blue" alt="TypeScript 5.6+" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
  <img src="https://img.shields.io/badge/tests-798+-brightgreen" alt="Tests" />
</p>

> Minimum 是一个专为 MiMo 模型设计的终端 AI 编码工作台，集成单 Agent 对话、W0-W4 多角色流水线、项目记忆系统、工具调用与审批治理，适合日常编码、复杂任务拆解与长周期项目协作。

---

## 目录

- [简介](#简介)
- [能力概览](#能力概览)
- [快速开始](#快速开始)
- [配置](#配置)
- [运行模式](#运行模式)
  - [单 Agent 模式](#单-agent-模式)
  - [W0-W4 流水线模式](#w0-w4-流水线模式)
  - [记忆系统](#记忆系统)
- [内置工具](#内置工具)
- [TUI 命令参考](#tui-命令参考)
- [架构设计](#架构设计)
- [开发指南](#开发指南)
- [测试](#测试)
- [许可证](#许可证)

---

## 简介

**Minimum** 运行在终端中，围绕 MiMo 的推理能力构建了一套完整的编码工作流。它既可以像传统命令行助手一样完成快速问答、代码修改、文件检索，也可以将复杂需求拆解为多阶段、多角色、多波次的协作流水线。

和“只有聊天框”的 CLI 工具不同，Minimum 提供了完整的 TUI、状态可观测能力、审批模式、项目记忆和可扩展工具层，适合真实项目中的持续开发，而不只是单轮问答。

**适用场景：**

- 终端内进行日常编码、调试、重构和问答
- 需要拆解复杂需求并分配给多个角色协同执行
- 希望跨会话保留项目上下文和开发经验
- 需要可控的工具执行与编辑审批流程

---

## 能力概览

| 能力 | 说明 |
| --- | --- |
| 单 Agent 对话 | 适合小规模修改、问答、排错、文件操作 |
| W0-W4 流水线 | 将复杂任务拆解为多个 Persona 协作执行 |
| 项目记忆 | 跨会话保存项目知识，减少重复解释成本 |
| Ink TUI | 终端交互界面，支持计划、工具进度和状态展示 |
| 审批治理 | 支持 `read-only`、`auto-edit`、`full-auto` |
| 工具体系 | 内置文件、搜索、Shell、Git、Web、Todo 等工具 |

---

## 快速开始

### 1. 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | >= 22 | 引擎和 TUI 均需 |
| npm | 任意版本 | 随 Node.js 安装 |

### 2. 克隆与构建

**Windows（PowerShell，推荐）：**

```powershell
git clone https://github.com/fengxijiu/minimum.git
cd minimum
.\scripts\build-all.ps1
```

如果遇到 PowerShell 执行限制，可先运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

可用选项：

```powershell
.\scripts\build-all.ps1
.\scripts\build-all.ps1 -NoLink
.\scripts\build-all.ps1 -Clean
```

**Linux / macOS（Bash，推荐）：**

```bash
git clone https://github.com/fengxijiu/minimum.git
cd minimum
scripts/build-all.sh
```

可用选项：

```bash
scripts/build-all.sh
scripts/build-all.sh --no-link
scripts/build-all.sh --clean
```

两个脚本都会按依赖顺序完成：

1. 构建引擎
2. 构建 TUI
3. 可选执行 `npm link` 注册全局 `minimum` 命令

### 3. 手动构建

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

### 4. 配置 API Key

**Windows（PowerShell）：**

```powershell
$env:MIMO_API_KEY="your_key_here"
```

**Linux / macOS（Bash）：**

```bash
export MIMO_API_KEY=your_key_here
```

Token Plan 用户使用 `tp-` 开头的 key 时，会自动选择 Token Plan 端点；如需手动指定区域，可额外配置 `MIMO_BASE_URL`。

**Windows（PowerShell）：**

```powershell
$env:MIMO_API_KEY="tp-your_key_here"
$env:MIMO_BASE_URL="https://token-plan-sgp.xiaomimimo.com/v1"
# 或：
# $env:MIMO_BASE_URL="https://token-plan-ams.xiaomimimo.com/v1"
```

**Linux / macOS（Bash）：**

```bash
export MIMO_API_KEY=tp-your_key_here
export MIMO_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1
# 或：
# export MIMO_BASE_URL=https://token-plan-ams.xiaomimimo.com/v1
```

### 5. 启动

**Windows（PowerShell）：**

```powershell
minimum
# 或直接运行
node .\bin\minimum-ink.js
```

**Linux / macOS（Bash）：**

```bash
minimum
# 或直接运行
node bin/minimum-ink.js
```

> 未设置 `MIMO_API_KEY` 时会自动进入 Mock 模式，适合先体验 UI 或调试终端交互。

---

## 配置

### 配置文件层级

配置按优先级从高到低合并，项目配置会覆盖全局配置：

| 层级 | 路径 | 说明 |
| --- | --- | --- |
| 项目级 | `.minimum/config.json` | 当前项目专属配置，`/init` 可自动生成 |
| 全局级 | `~/.minimum/config.json` | 所有项目共享的默认配置 |

### 配置示例

```json
{
  "apiKey": "your_key_here",
  "baseUrl": "https://api.xiaomimimo.com/v1",
  "defaultModel": "mimo-v2.5-pro",
  "approvalMode": "auto-edit",
  "editMode": "auto"
}
```

如果你使用 Token Plan，也可以将 `baseUrl` 改为对应区域端点，例如：

```json
{
  "apiKey": "tp-your_key_here",
  "baseUrl": "https://token-plan-sgp.xiaomimimo.com/v1"
}
```

### 可用模型

| 模型 | 说明 |
| --- | --- |
| `mimo-v2.5-pro` | 专业版，长上下文一致性更强，推荐用于复杂编码任务 |
| `mimo-v2.5` | 标准版，支持图片理解与多模态能力 |

### API 端点

| 场景 | URL |
| --- | --- |
| 默认（中国） | `https://api.xiaomimimo.com/v1` |
| Token Plan 新加坡 | `https://token-plan-sgp.xiaomimimo.com/v1` |
| Token Plan 欧洲 | `https://token-plan-ams.xiaomimimo.com/v1` |

### 环境变量

| 变量名 | 说明 | 默认值 |
| --- | --- | --- |
| `MIMO_API_KEY` | MiMo API 认证密钥 | 未设置时进入 Mock 模式 |
| `MIMO_BASE_URL` | API 端点地址 | `https://api.xiaomimimo.com/v1` |
| `MINIMUM_ENABLE_SHELL` | 启用 Shell 工具执行 | `0` |
| `MINIMUM_TELEMETRY` | 启用遥测收集 | `1` |

---

## 运行模式

Minimum 主要由三部分能力构成：单 Agent 对话、W0-W4 多角色流水线，以及跨会话项目记忆系统。三者既能独立使用，也能在复杂任务中联动。

### 单 Agent 模式

默认模式，适合快速问答、小规模改动、文件操作与即时调试。

**工作流程：**

1. 用户输入消息
2. 模型返回文本与工具调用请求
3. 引擎按审批策略执行工具
4. 工具结果回传模型，继续推理
5. 直到输出最终回复

**关键机制：**

- 流式输出，默认 100ms 缓冲刷新
- 只读工具可并发执行，加快信息收集
- 单个工具结果有截断保护，避免上下文过载
- 自动修复不完整消息序列
- 文件编辑支持快照与 `/undo`
- 计划步骤可视化展示

**审批模式：**

| 模式 | 说明 |
| --- | --- |
| `read-only` | 仅允许读取，写入和执行需手动确认 |
| `auto-edit` | 自动批准文件编辑，Shell 执行需确认 |
| `full-auto` | 全自动执行 |

**编辑模式：**

| 模式 | 说明 |
| --- | --- |
| `review` | 应用前展示 diff 预览 |
| `auto` | 自动应用编辑 |
| `yolo` | 自动应用并跳过验证 |

### W0-W4 流水线模式

通过 `/orchestrate <需求>` 启动，适合复杂功能开发、多文件重构、需要分角色协作的任务。

流水线会将一个大任务拆解为多个子任务，按依赖关系划分波次，并分配给不同 Persona 并发执行，最终由 `master_planner` 汇总结果。

#### 流水线阶段

| 阶段 | 职责 |
| --- | --- |
| W0 TaskCompiler | 读取上下文与记忆，生成粗粒度任务合约 |
| W0.5 Refiner | 精化任务字段并校验路径策略与完整性 |
| W1 感知波 | 并发完成需求理解、仓库扫描、上下文构建 |
| W2/W3 实现与校验波 | 代码实现、测试编写、运行验证、文档补充 |
| W4 Finalize | 汇总结果、执行记忆治理、输出最终报告 |

#### Persona 角色

| 角色 | 类型 | 职责 | 可写 | 最大并发 |
| --- | --- | --- | --- | --- |
| `master_planner` | master | 任务编排、合约生成、最终汇总 | — | 1 |
| `vision` | worker | 需求理解、UI/UX 分析 | ✗ | 1 |
| `repo_scout` | worker | 仓库结构与依赖分析 | ✗ | 1 |
| `context_builder` | worker | 聚合上下文，生成 ContextPack | ✗ | 1 |
| `code_executor` | worker | 实现代码修改 | ✓ | 3 |
| `test_writer` | worker | 编写测试 | ✓ | 2 |
| `test_runner` | worker | 执行测试与分析结果 | ✗ | 1 |
| `runtime_debug` | worker | 运行时调试与错误诊断 | ✓ | 1 |
| `reviewer` | worker | 代码审查与质量检查 | ✗ | 1 |
| `docs` | worker | 文档与注释补充 | ✓ | 1 |

#### 并发与安全

- `TaskGraph` 保证同一波次内并发任务的路径策略不冲突
- `soloPerWave` 任务可独占整个 Wave
- `PathPolicyEnforcer` 统一约束读写范围
- 只读 Persona 无法突破 `canWrite: false` 限制
- `.minimum/memory.md` 等核心文件由记忆治理模块专管

#### TaskContract 示例

```typescript
interface TaskContract {
  taskId: string;
  phase: string;
  epicId: string;
  personaId: PersonaId;
  objective: string;
  inputs: TaskInputs;
  pathPolicy: TaskPathPolicy;
  acceptance: string[];
  outputSchema: OutputSchema;
  parallelGroup: string;
  dependsOn: string[];
  abortOnConflict: boolean;
}
```

### 记忆系统

记忆系统让 Minimum 可以跨会话积累项目知识，减少重复解释，提高后续任务上下文质量。

#### 三层记忆架构

| 层级 | 说明 |
| --- | --- |
| ProjectMemory | 项目级记忆，持久化在 `.minimum/memory.md` |
| SessionMemory | 当前会话上下文，可选择沉淀到项目记忆 |
| RuntimeMemory | 运行期临时状态，如工具结果、编辑快照 |

#### 记忆治理流程

W4 Finalize 阶段会统一收集 `MemoryCandidate[]`，再由 `master_planner` 决定：

- `merge`：写入 `.minimum/memory.md`
- `archive`：归档到 `_archive/`
- `reject`：丢弃

#### 关键设计

- Fence-aware 合并，不破坏已有代码块围栏
- 记忆条目保留 `source_task`、`persona`、`related_files` 元数据
- 按 token 预算加载记忆，避免挤占上下文窗口
- 为不同 Worker 按相关性排序注入上下文

#### 记忆命令

| 命令 | 说明 |
| --- | --- |
| `/memory` | 显示项目记忆文件路径和大小 |
| `/compact` | 查看上下文压缩状态 |
| `/init` | 初始化 `.minimum/` 目录结构 |

---

## 内置工具

| 工具 | 类别 | 说明 |
| --- | --- | --- |
| `read_file` | 读取 | 读取文件内容，支持行范围和编码 |
| `edit_file` | 编辑 | SEARCH/REPLACE 块编辑 |
| `apply_patch` | 编辑 | 安全的 hunk 级编辑 |
| `write_file` | 编辑 | 创建或覆写文件 |
| `exec_shell` | 执行 | 执行 Shell 命令，需启用 `MINIMUM_ENABLE_SHELL=1` |
| `grep` | 搜索 | 正则代码搜索 |
| `glob` | 搜索 | 文件名模式匹配 |
| `git` | 版本控制 | Git 操作封装 |
| `web_fetch` | 网络 | 抓取网页内容 |
| `todo` | 任务 | 管理待办事项 |

**安全策略：**

- `PathPolicyEnforcer` 基于 Persona 控制路径访问
- `ToolAllowlistEnforcer` 负责工具白名单与黑名单过滤
- Shell 工具默认关闭，需要显式启用

---

## TUI 命令参考

在输入框输入 `/` 可以打开命令面板并进行模糊搜索。

| 命令 | 别名 | 说明 |
| --- | --- | --- |
| `/orchestrate <需求>` | `pipeline` `orch` | 启动 W0-W4 流水线 |
| `/new` | `reset` | 开启新会话 |
| `/save [name]` | - | 保存当前会话 |
| `/load <name>` | - | 加载已保存会话 |
| `/sessions` | `ls` | 列出已保存会话 |
| `/clear` | `cls` | 清空聊天记录 |
| `/context` | `ctx` | 显示 token 用量 |
| `/compact` | - | 查看上下文压缩状态 |
| `/undo` | - | 撤销最后一次暂存编辑 |
| `/redo` | - | 重做已撤销编辑 |
| `/memory` | `mem` | 显示项目记忆路径 |
| `/plan` | - | 显示当前计划进度 |
| `/mode [agent\|chat]` | - | 切换模式 |
| `/permission [mode]` | `perm` `approval` `appr` | 设置审批模式 |
| `/editmode [mode]` | - | 设置编辑模式 |
| `/verbose` | `v` | 切换详细输出 |
| `/run <cmd>` | - | 运行 shell 命令 |
| `/mcp` | - | 查看 MCP Server 状态 |
| `/status` | - | 显示会话状态摘要 |
| `/tools` | - | 列出可用工具 |
| `/model` | - | 显示当前模型 |
| `/config` | `cfg` | 显示配置信息 |
| `/init` | - | 初始化当前项目配置 |
| `/help` | `?` | 显示快捷键帮助 |
| `/quit` | `exit` `q` | 退出 |

---

## 架构设计

### 目录结构

下面只列出最关键的目录，完整结构请以仓库实际内容为准：

```text
minimum/
├── bin/                 # CLI 入口
├── src/                 # 引擎层
│   ├── loop/            # 单 Agent 推理循环
│   ├── orchestration/   # W0-W4 流水线编排
│   ├── personas/        # Persona 定义
│   ├── memory/          # 项目记忆系统
│   ├── tools/           # 内置工具
│   ├── bridge/          # Engine/Pipeline -> UiEvent
│   └── config/          # 配置加载与初始化
├── tui/src/             # Ink 终端 UI
│   ├── components/      # 组件
│   ├── state/           # 状态机
│   └── theme/           # 主题上下文
├── scripts/             # 构建脚本
│   ├── build-all.ps1
│   ├── build-all.sh
│   └── copy-assets.mjs
├── tests/               # 单元与集成测试
├── docs/                # 文档
└── doc/                 # 设计文档
```

### 核心模块

| 模块 | 说明 |
| --- | --- |
| `MiMoLoop` | 单 Agent 推理循环核心，负责 stream -> tool -> loop |
| `MiMoPipeline` | 多 Persona 流水线总编排器 |
| `TaskCompiler` / `Refiner` / `WaveScheduler` | 负责任务合约、精化与波次调度 |
| `EngineBridge` / `PipelineBridge` | 将内部事件翻译为前端可消费的 `UiEvent` |
| `ProjectMemory` / `MemoryGovernor` | 项目记忆存储与治理 |
| `ToolRegistry` | 内置工具注册与调用入口 |
| `ApprovalManager` | 审批模式与交互控制 |

### 数据流

```text
用户输入
  -> TUI Runner
  -> EngineBridge / PipelineBridge
  -> MiMoLoop / MiMoPipeline
  -> MiMo API Client
  -> 工具调用 / 推理结果
  -> UiEvent
  -> TUI 渲染
```

---

## 开发指南

### 常用命令

**Windows（PowerShell）：**

```powershell
# 一键构建
.\scripts\build-all.ps1

# 引擎开发
npm run dev

# TUI 开发
Set-Location .\tui
npm run dev
Set-Location ..

# 测试
npm test
npm run test:watch
npm run test:coverage

# 质量检查
npm run lint
npm run lint:fix
npm run format
npm run typecheck
```

**Linux / macOS（Bash）：**

```bash
# 一键构建
scripts/build-all.sh

# 引擎开发
npm run dev

# TUI 开发
cd tui && npm run dev

# 测试
npm test
npm run test:watch
npm run test:coverage

# 质量检查
npm run lint
npm run lint:fix
npm run format
npm run typecheck
```

### 新增工具

1. 在 `src/tools/` 下创建新目录
2. 实现工具接口，定义 `name`、`description`、`parameters` 和 `execute()`
3. 在 `src/tools/ToolRegistry.ts` 中注册
4. 在 `tui/src/engine.ts` 中补充工具分类映射
5. 为新工具补充单元测试

### 新增 Persona

1. 在 `src/personas/Persona.ts` 中扩展 `PersonaId`
2. 注册 Persona 的模型、工具白名单和路径策略
3. 在 `MiMoPipeline.ts` 中定义该角色所属阶段

### 新增 TUI 组件

1. 在 `tui/src/components/` 下创建组件
2. 在 `app.tsx` 中接入对应 Zone
3. 如需新增事件类型，在 `state/events.ts` 和 `reducer.ts` 中同步处理

---

## 测试

```bash
npm test
```

当前仓库包含 **798+ 个单元测试**，覆盖以下核心模块：

| 模块 | 测试数 | 说明 |
| --- | --- | --- |
| 工具层 | 76+ | 文件系统、Git、搜索、Web 工具 |
| 审批系统 | 36 | 权限策略、审批流程 |
| 记忆治理 | 24+ | 合并、评分、暂存、清单 |
| 编排器 | 22+ | 任务编排、波次调度 |
| 桥接层 | 44 | EngineBridge / PipelineBridge |
| 技能系统 | 24 | 技能加载与注册 |
| 容量控制 | 19 | Token 预算、上下文窗口 |
| 遥测 | 24 | 事件统计 |
| 子代理 | 22 | 子代理生命周期 |
| TUI 状态机 | - | Flux reducer 全路径覆盖 |
| 钩子系统 | 20 | 生命周期钩子 |

---

## 许可证

[MIT License](LICENSE)

---

## 致谢

感谢 [resonix](https://github.com/resonix-dev/resonix)（@resonix-dev）、[pi code](https://github.com/earendil-works/pi)（@earendil-works）和 [CodeWhale](https://github.com/Hmbown/CodeWhale)（@Hmbown）在 Minimum 的设计与演进过程中带来的启发与帮助。

---
