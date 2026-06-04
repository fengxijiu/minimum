<p align="center">
  <img src="icon.png" alt="Minimum" width="120" />
</p>

<h1 align="center">Minimum</h1>

<p align="center">
  <strong>MiMo Coding Experience Optimization</strong><br/>
  面向 MiMo 模型的终端编码工作台 · TypeScript 引擎 + Ink TUI + 多角色编排
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node >= 22" />
  <img src="https://img.shields.io/badge/typescript-5.6+-blue" alt="TypeScript 5.6+" />
  <img src="https://img.shields.io/badge/ui-Ink_TUI-purple" alt="Ink TUI" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
</p>

> Minimum 是一个围绕 MiMo API 构建的终端编码助手。它同时提供单 Agent 对话、`/orchestrate` 多角色流水线、审批治理、项目配置、会话命令面板和 `.minimum/` 记忆体系，适合真实代码仓中的持续开发与协作。

---

## 目录

- [简介](#简介)
- [能力概览](#能力概览)
- [快速开始](#快速开始)
- [配置](#配置)
- [运行模式](#运行模式)
- [内置工具](#内置工具)
- [TUI 命令参考](#tui-命令参考)
- [架构设计](#架构设计)
- [开发指南](#开发指南)
- [测试](#测试)
- [许可证](#许可证)
- [致谢](#致谢)

---

## 简介

**Minimum** 由两层组成：

- 根目录 `src/` 是 MiMo 引擎，负责配置加载、工具调用、审批控制、上下文治理、验证与编排。
- `tui/` 是基于 Ink 的终端界面，负责欢迎页、命令面板、聊天流、计划条、流水线面板和状态栏。

相比“只会聊天”的 CLI，Minimum 更像一个终端内工作台：

- 可以在 `chat` / `agent` / `orchestrate` 三种模式间切换
- 支持 `/` 命令面板、文件作用域、会话命令和状态提示
- 通过 `ApprovalManager` 控制读写与 Shell 行为
- 通过 `EngineBridge` / `PipelineBridge` 把后端事件转成可视化 UI 状态
- 支持 `.minimum/config.json`、`~/.minimum/config.json` 和环境变量混合配置

---

## 能力概览

| 能力 | 当前实现 |
| --- | --- |
| 单 Agent 运行 | `MiMoLoop` 处理流式回复、工具调用、验证、修复和上下文折叠 |
| 多角色编排 | `MiMoPipeline` + `TaskCompiler` + `Refiner` + `WorkerLoop`，按 Plan → Scan → Refine → Build → Accept → Finalize 六阶段推进 |
| TUI 交互 | 欢迎屏、命令面板、计划条、聊天流、状态栏、流水线进度面板 |
| 审批治理 | `read-only`、`auto-edit`、`full-auto`，引擎层还保留 `suggest`、`never` |
| 工具系统 | 文件、搜索、Git、Web、Todo，Shell 可选启用 |
| 项目初始化 | `/init` 生成 `.minimum/` 配置和记忆目录 |
| 会话命令 | `/save`、`/load`、`/sessions`、`/new`、`/clear` 等 |
| 记忆治理 | Manifest、canonical memory、staging、archive、memory index |

---

## 快速开始

### 1. 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | >= 22 | 根引擎构建与运行要求 |
| npm | 随 Node.js 安装 | 安装依赖、构建和测试 |
| PowerShell / Bash | 任一 | 分别对应 Windows 与 Linux/macOS 启动脚本 |

### 2. 克隆与一键构建

**Windows（PowerShell）：**

```powershell
git clone https://github.com/fengxijiu/minimum.git
cd minimum
.\scripts\build-all.ps1
```

如果脚本执行被限制，可先运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

构建脚本支持：

```powershell
.\scripts\build-all.ps1
.\scripts\build-all.ps1 -NoLink
.\scripts\build-all.ps1 -Clean
```

**Linux / macOS（Bash）：**

```bash
git clone https://github.com/fengxijiu/minimum.git
cd minimum
scripts/build-all.sh
```

构建脚本支持：

```bash
scripts/build-all.sh
scripts/build-all.sh --no-link
scripts/build-all.sh --clean
```

两个脚本都会按顺序完成：

1. 安装根项目依赖并构建 `dist/index.js`
2. 安装 `tui/` 依赖并构建 `tui/dist/cli.js`
3. 可选执行 `npm link`，注册全局 `minimum`

### 3. 手动构建

```bash
# 根引擎
npm install
npm run build

# TUI
cd tui
npm install
npm run build
cd ..

# 可选：注册全局命令
npm link
```

### 4. 配置 MiMo API

**Windows（PowerShell）：**

```powershell
$env:MIMO_API_KEY="sk-your_key_here"
```

**Linux / macOS（Bash）：**

```bash
export MIMO_API_KEY=sk-your_key_here
```

如果使用 Token Plan，`tp-` 前缀的 key 会自动走 Token Plan China 端点；如需手动指定区域，可显式设置 `MIMO_BASE_URL`。

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

如需启用 Shell 工具，还需要额外开启：

**Windows（PowerShell）：**

```powershell
$env:MIMO_ENABLE_SHELL="1"
```

**Linux / macOS（Bash）：**

```bash
export MIMO_ENABLE_SHELL=1
```

### 5. 初始化项目配置

首次进入某个仓库后，推荐在 TUI 中执行：

```text
/init
```

这会为当前项目准备 `.minimum/` 目录，并写入项目级配置；全局配置默认位于 `~/.minimum/config.json`。

### 6. 启动

**Windows（PowerShell）：**

```powershell
minimum
# 或
node .\bin\minimum-ink.js
```

**Linux / macOS（Bash）：**

```bash
minimum
# 或
node bin/minimum-ink.js
```

> 未设置 `MIMO_API_KEY` 时，TUI 会退回 Mock Runner，方便先检查界面、命令面板和项目扫描流程。

---

## 配置

### 配置优先级

运行时与文件配置会一起参与解析，常见优先级可以概括为：

1. 环境变量：`MIMO_API_KEY`、`MIMO_BASE_URL`
2. 项目级配置：`.minimum/config.json`
3. 全局级配置：`~/.minimum/config.json`

项目配置会覆盖全局配置；环境变量会在启动时覆盖关键连接信息。

### 配置示例

```json
{
  "apiKey": "sk-your_key_here",
  "baseUrl": "https://api.xiaomimimo.com/v1",
  "defaultModel": "mimo-v2.5-pro",
  "maxTokens": 131072,
  "maxSteps": 50,
  "approvalMode": "suggest",
  "enableReadGuard": true,
  "context": {
    "foldThreshold": 0.7,
    "aggressiveThreshold": 0.75,
    "tailFraction": 0.25
  },
  "validation": {
    "enabled": true,
    "syntax": true,
    "tsc": true,
    "pattern": true
  }
}
```

### 模型

| 模型 | 说明 |
| --- | --- |
| `mimo-v2.5-pro` | 默认模型，适合 Agentic 长上下文与复杂编码任务 |
| `mimo-v2.5` | 标准版，支持图片理解与多模态输入 |

### API 端点

| 场景 | URL |
| --- | --- |
| 默认 API | `https://api.xiaomimimo.com/v1` |
| Token Plan China | `https://token-plan-cn.xiaomimimo.com/v1` |
| Token Plan Singapore | `https://token-plan-sgp.xiaomimimo.com/v1` |
| Token Plan Europe | `https://token-plan-ams.xiaomimimo.com/v1` |

### 审批模式

引擎配置支持以下取值：

| 模式 | 说明 |
| --- | --- |
| `read-only` | 只允许低风险读操作 |
| `auto-edit` | 文件编辑自动放行，Shell 需确认 |
| `full-auto` | 全自动执行 |
| `suggest` | 低风险自动放行，其余等待确认 |
| `never` | 全部拒绝 |

TUI 的 `/permission` 命令当前暴露的是 `read-only`、`auto-edit`、`full-auto` 三档快速切换。

### 环境变量

| 变量名 | 说明 | 默认行为 |
| --- | --- | --- |
| `MIMO_API_KEY` | MiMo API key | 未设置时进入 Mock 模式 |
| `MIMO_BASE_URL` | 显式 API 端点 | 未设置时按 key 前缀自动推断 |
| `MIMO_ENABLE_SHELL` | 是否注册 `exec_shell` | `0`，默认关闭 |

### `.minimum/` 目录

运行 `/init` 与流水线任务后，项目下通常会逐步出现：

- `.minimum/config.json`：项目级配置
- `.minimum/manifest.yaml`：记忆清单与 canonical memory 布局
- `.minimum/_staging/`：流水线阶段写入的 memory candidate
- `.minimum/_archive/`：归档的历史记忆
- 多个 canonical `*.md` 文件，例如 `project.md`、`architecture.md`、`tests.md`

---

## 运行模式

### TUI 模式

TUI 当前支持三种主模式：

| 模式 | 说明 |
| --- | --- |
| `chat` | 更偏轻量问答与自然对话 |
| `agent` | 默认工作模式，适合常规编码与工具调用 |
| `orchestrate` | 启动多角色流水线，按 Plan → Scan → Refine → Build → Accept → Finalize 六阶段推进 |

`Tab` / `/mode` 可在模式间切换；状态栏会同步显示当前状态。

### 单 Agent 引擎

根引擎由 `MiMoLoop` 驱动，负责：

- 流式消费模型输出
- 识别工具调用并通过 `ToolRegistry` 执行
- 把审批请求交给 `ApprovalManager`
- 触发验证、修复、完整性检查与上下文折叠
- 通过 `EngineBridge` 转换成 TUI 可消费的 `UiEvent`

### 多角色流水线

`/orchestrate <request>` 会切换到 `PipelineBridge` + `MiMoPipeline` 路径，按六个阶段依次推进：

| 阶段 | 核心工作 | 关键组件 |
| --- | --- | --- |
| **Plan** | 任务分解、合约生成与细化 | `TaskCompiler` → `Refiner` |
| **Scan** | 仓库扫描、上下文构建、Persona 分配 | `RepoScout` / `ContextBuilder` |
| **Refine** | 合约细化、门控检查、依赖排序 | `LaunchGate` → `Refiner` |
| **Build** | Worker 多轮工具调用实现与测试 | `WorkerLoop` + `WaveScheduler` |
| **Accept** | 评审、验证、Mission Check | `MissionChecker` + `Reviewer` |
| **Finalize** | 结果汇总、记忆治理、最终交付 | `MemoryGovernor` + pipeline artifacts |

每个阶段由 `PipelineBridge` 把事件转为 TUI 可见状态，`PipelinePanel` 展示六阶段进度条，`SubagentBrief` 展示各 worker 的实时状态。

### 记忆体系

当前仓库里与记忆相关的实现并不只是一份文件，而是两套协作组件：

- `ProjectMemory`：简单键值型项目记忆存储
- `memory/governance/*`：manifest、staging、archive、canonical memory、index、scoring
- `SessionMemory` / `RuntimeMemory`：会话与运行时上下文

对外使用时，更适合把它理解为“`.minimum/` 下的一套记忆目录和治理流程”，而不是单一文件。

### 当前 TUI 可见界面

现在的 Ink 界面由这些区域组成：

| 区域 | 组件 |
| --- | --- |
| 顶栏 | `TitleBar` |
| 计划条 | `PlanStrip` |
| 编排进度 | `PipelinePanel` + `SubagentBrief`（混合面板，展示阶段进度与 worker 实时状态） |
| 聊天流 | `ChatStream` |
| 输入区 | `InputArea` |
| 状态栏 | `StatusBar` |
| 欢迎页 | `WelcomeScreen` |
| 命令面板 | `CommandPalette` |

---

## 内置工具

### TUI 默认注册的工具

当前 `tui/src/engine.ts` 会注册以下工具：

| 工具名 | 作用 |
| --- | --- |
| `read_file` | 读取文件 |
| `list_directory` | 列目录 |
| `write_file` | 写入或覆盖文件 |
| `edit_file` | 搜索替换式编辑 |
| `apply_patch` | hunk 级补丁编辑 |
| `grep` | 文本 / 代码搜索 |
| `glob` | 文件匹配 |
| `git` | Git 信息查询与操作 |
| `web_fetch` | 拉取网页内容 |
| `todo_write` | 写入任务列表 |
| `exec_shell` | Shell 执行，需 `MIMO_ENABLE_SHELL=1` |

### 安全边界

- `ApprovalManager` 负责审批决策与习惯缓存
- `PathPolicyEnforcer` 负责 Persona 的读写范围约束
- `ToolAllowlistEnforcer` 负责工具白名单与黑名单
- `exec_shell` 默认不会注册，必须显式启用
- 多角色流水线下，worker 的可写路径会受到 `TaskContract` 与 Persona 策略双重限制

---

## TUI 命令参考

在输入框输入 `/` 可以打开命令面板，进行模糊搜索并查看命令说明。

### 会话命令

| 命令 | 别名 | 说明 |
| --- | --- | --- |
| `/new` | `reset` | 开启新会话并清空暂存状态 |
| `/save [name]` | - | 保存当前会话 |
| `/load <name>` | - | 加载会话 |
| `/sessions` | `ls` | 查看已保存会话 |
| `/quit` | `exit` `q` | 退出 Minimum |

### 上下文命令

| 命令 | 别名 | 说明 |
| --- | --- | --- |
| `/compact` | - | 查看上下文折叠 / 压缩状态 |
| `/context` | `ctx` | 查看上下文窗口使用量 |
| `/undo` | - | 撤销最后一次暂存编辑 |
| `/redo` | - | 重做已撤销编辑 |
| `/memory` | `mem` | 查看项目记忆路径提示 |

### 视图命令

| 命令 | 别名 | 说明 |
| --- | --- | --- |
| `/copy` | - | 复制最后一条助手回复 |
| `/diff` | - | 切换 / 查看当前 diff 显示状态 |
| `/plan` | - | 显示当前计划摘要 |
| `/mode <agent|chat|orchestrate>` | - | 切换运行模式 |
| `/orchestrate <request>` | `pipeline` `orch` | 启动多角色流水线，Plan → Scan → Refine → Build → Accept → Finalize |
| `/clear` | `cls` | 清空聊天流 |
| `/verbose` | `v` | 切换详细输出 |

### 系统命令

| 命令 | 别名 | 说明 |
| --- | --- | --- |
| `/permission <mode>` | `approval` `appr` `perm` | 切换审批模式 |
| `/editmode <mode>` | - | 切换编辑模式：`review` / `auto` / `yolo` |
| `/run <cmd>` | - | 请求运行 Shell 命令 |
| `/mcp` | - | 查看 MCP 服务状态 |
| `/status` | - | 查看会话摘要 |
| `/tools` | - | 列出当前已注册工具 |
| `/model` | - | 显示当前模型 |
| `/skill` | - | 查看技能命令入口 |
| `/config` | `cfg` | 查看当前配置摘要 |
| `/init` | - | 初始化当前项目的 `.minimum/` |
| `/help` | `?` | 显示帮助 |

---

## 架构设计

### 仓库结构

```text
minimum/
├── bin/                     # CLI 入口，转发到 TUI
├── src/                     # 引擎与编排核心
│   ├── approval/            # 审批治理
│   ├── bridge/              # EngineBridge / PipelineBridge
│   ├── commands/            # /init /config /memory 等命令实现
│   ├── config/              # 配置类型、加载与 stack 工厂
│   ├── loop/                # MiMoLoop
│   ├── memory/              # 记忆存储与治理
│   ├── orchestration/       # MiMoPipeline / TaskCompiler / WaveScheduler / WorkerLoop / LaunchGate
│   ├── personas/            # Persona 定义与 prompts
│   ├── tools/               # 文件、Git、搜索、Web、Todo、Shell
│   ├── validators/          # 语法 / 类型 / pattern 检查
│   └── session/             # 会话与检查点
├── tui/src/                 # Ink TUI
│   ├── components/          # 界面组件
│   ├── state/               # reducer / store / events
│   ├── engine.ts            # TUI 与引擎桥接入口
│   └── commands.ts          # Slash commands
├── scripts/                 # 构建脚本与资源复制
├── tests/                   # 单元与集成测试
├── docs/                    # 执行计划 / checklist
└── doc/                     # 设计、架构、路线图和报告
```

### 核心模块

| 模块 | 职责 |
| --- | --- |
| `MiMoClient` | 管理 MiMo API 调用与 base URL 解析 |
| `MiMoLoop` | 单 Agent 主循环 |
| `MiMoPipeline` | 多角色流水线执行器 |
| `TaskCompiler` / `Refiner` / `TaskRunner` / `WaveScheduler` / `WorkerLoop` | 任务合约、细化、执行、并发调度与 worker 多轮工具循环 |
| `LaunchGate` / `MissionChecker` | 门控检查：上下文缺口、合约就绪、验收通过 |
| `ApprovalManager` | 工具风险判断、审批模式、确认缓存 |
| `ToolRegistry` | 工具注册与统一执行入口 |
| `ContextManager` | 上下文折叠与 token 管理 |
| `CodeValidator` / `CompletenessChecker` | 代码验证与完整性检查 |
| `EngineBridge` / `PipelineBridge` | 把后端事件转换成 `UiEvent` |
| `MemoryGovernor` / `MemoryManifest` / `MemoryIndex` | canonical memory 与记忆治理 |

### 运行数据流

```text
用户输入
  -> TUI App
  -> runCommand / Runner
  -> EngineBridge 或 PipelineBridge
  -> MiMoLoop 或 MiMoPipeline
  -> MiMoClient + ToolRegistry + ApprovalManager
  -> UiEvent
  -> Ink 组件渲染
```

---

## 开发指南

### 常用命令

**Windows（PowerShell）：**

```powershell
# 根项目
npm install
npm run build
npm run dev
npm test
npm run test:watch
npm run test:coverage
npm run lint
npm run lint:fix
npm run format
npm run typecheck

# 一键构建
.\scripts\build-all.ps1

# TUI
Set-Location .\tui
npm install
npm run dev
npm run build
npm run verify
Set-Location ..
```

**Linux / macOS（Bash）：**

```bash
# 根项目
npm install
npm run build
npm run dev
npm test
npm run test:watch
npm run test:coverage
npm run lint
npm run lint:fix
npm run format
npm run typecheck

# 一键构建
scripts/build-all.sh

# TUI
cd tui
npm install
npm run dev
npm run build
npm run verify
cd ..
```

### 开发约定

- 根项目 `build` 会编译 `src/` 并执行 `scripts/copy-assets.mjs`
- TUI 单独维护自己的 `package.json`、`tsconfig.json` 和构建流程
- `bin/minimum-ink.js` 实际上只是转发到 `tui/dist/cli.js`
- 如果要联调真实引擎，需要先构建根项目，否则 TUI 会退回 Mock 模式

### 新增工具

1. 在 `src/tools/` 对应分类下实现工具
2. 在 `src/index.ts` 暴露导出
3. 在 `tui/src/engine.ts` 决定是否注册到默认工具集
4. 如涉及权限，补充 `ApprovalManager` 或策略层测试
5. 在 `tests/` 添加单元或集成测试

### 新增 Persona

1. 在 `src/personas/Persona.ts` 扩展 `PersonaId`
2. 在 `src/personas/PersonaRegistry.ts` 配置模型、工具白名单、路径策略与并发参数
3. 在 `src/personas/prompts/` 增加角色 prompt
4. 在编排阶段中接入任务分配逻辑

### 新增 TUI 组件

1. 在 `tui/src/components/` 添加组件
2. 在 `tui/src/app.tsx` 接入对应 Zone
3. 如需新增事件，更新 `tui/src/state/events.ts` 与 `reducer.ts`
4. 为 TUI reducer、command 或渲染逻辑补测试

---

## 测试

根项目使用 Vitest，测试分为：

- `tests/unit/`：工具、配置、审批、记忆、编排、TUI reducer 等单元测试
- `tests/integration/`：session、pipeline、memory persistence、transcript replay 等集成测试

常用命令：

```bash
npm test
npm run test:watch
npm run test:coverage
```

TUI 子包还提供一个额外的校验命令：

```bash
cd tui
npm run verify
```

当前仓库的测试覆盖重点包括：

- 工具注册与执行
- 审批模式与权限判断
- 配置加载与初始化
- 多角色流水线、任务合约、worker loop
- 记忆治理与索引
- TUI reducer、命令、markdown 渲染和 engine bridge

---

## 许可证

[MIT License](LICENSE)

---

## 致谢

感谢 [resonix](https://github.com/resonix-dev/resonix)（@resonix-dev）、[pi code](https://github.com/earendil-works/pi)（@earendil-works）和 [CodeWhale](https://github.com/Hmbown/CodeWhale)（@Hmbown）在 Minimum 的设计与演进过程中带来的启发与帮助。

同时感谢 [superpowers](https://github.com/obra/superpowers) 在任务分解、计划驱动执行、persona skill 组织和可复用工作流方法上的启发；Minimum-native Superpowers 的整合也受益于这些实践。

---
