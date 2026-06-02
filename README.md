<p align="center">
  <img src="icon.png" alt="Minimum" width="120" />
</p>

<h1 align="center">Minimum</h1>

<p align="center">
  <strong>the minimum effort for maximum productivity</strong><br/>
  面向 MiMo 的终端编码工作台：Ink TUI、单 Agent、W0-W4 多角色流水线、权限治理与项目记忆。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node >= 22" />
  <img src="https://img.shields.io/badge/typescript-5.6+-blue" alt="TypeScript" />
  <img src="https://img.shields.io/badge/ui-Ink-purple" alt="Ink TUI" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT" />
</p>

Minimum 是一个运行在真实代码仓里的 MiMo coding agent。它的主入口是 `minimum` / `minimum-ink` TUI：启动后自动识别当前 workspace，提供聊天流、工具审批、命令面板、流水线进度、项目记忆和可召唤的 liliMiMO pet。

未配置 MiMo API key 时，TUI 会自动进入 mock 模式，仍可预览界面、命令面板和基础交互。

## Highlights

- **Ink TUI**：自适应启动页、聊天流、计划条、流水线面板、状态栏、权限选择条。
- **Single-agent loop**：流式输出、工具调用、审批请求、上下文折叠、验证与修复事件。
- **W0-W4 pipeline**：`/orchestrate` 启动多 persona 编排，并包含 W3.5 mission check 回环。
- **Persona system**：固定角色表、工具 allowlist、路径策略、context pack 和 memory candidate 协议。
- **Persistent artifacts**：DAG、refinement、contracts、repair DAG、W3.5 报告落盘到 `.minimum/tasks/<epic>/`。
- **Memory governance**：canonical memory、staging candidates、archive、确定性 `.minimum/index.json`，不依赖向量检索。
- **Permission UX**：权限请求用左右键选择，`Enter` 确认，`Esc` 拒绝；避免误触快捷键。
- **liliMiMO pet**：默认隐藏，输入 `/pet` 后在空闲 live tail 中显示半块字符 mascot。

## Quick Start

### Requirements

| Dependency | Version |
| --- | --- |
| Node.js | `>=22` for the root engine |
| npm | bundled with Node.js |
| PowerShell / Bash | for build scripts |

### Build Everything

Windows:

```powershell
git clone https://github.com/fengxijiu/minimum.git
cd minimum
.\scripts\build-all.ps1
```

Linux / macOS:

```bash
git clone https://github.com/fengxijiu/minimum.git
cd minimum
scripts/build-all.sh
```

Both build scripts install dependencies, build the root engine, build the TUI, and optionally run `npm link` so `minimum` is available globally.

### Manual Build

```bash
npm install
npm run build

cd tui
npm install
npm run build
cd ..

npm link
```

### Run

```bash
minimum
# or
node bin/minimum-ink.js
```

On Windows PowerShell:

```powershell
minimum
# or
node .\bin\minimum-ink.js
```

## Configuration

Minimum reads connection settings from environment variables, project config, and global config.

| Source | Path / variable |
| --- | --- |
| Environment | `MIMO_API_KEY`, `MIMO_BASE_URL`, `MIMO_ENABLE_SHELL` |
| Project config | `.minimum/config.json` |
| Global config | `~/.minimum/config.json` |

Set a live MiMo key:

```bash
export MIMO_API_KEY=sk-your_key_here
```

PowerShell:

```powershell
$env:MIMO_API_KEY="sk-your_key_here"
```

Token Plan keys with `tp-` prefix are supported. `MIMO_BASE_URL` can be set explicitly when a specific endpoint is required.

Shell execution is disabled by default:

```bash
export MIMO_ENABLE_SHELL=1
```

PowerShell:

```powershell
$env:MIMO_ENABLE_SHELL="1"
```

Initialize project config from inside the TUI:

```text
/init
```

## TUI Usage

The TUI starts with a boxed welcome screen that adapts to terminal width and uses the current launch directory as `workspace`.

Common keys:

| Key | Behavior |
| --- | --- |
| `/` | open command palette |
| `@` | open file picker |
| `Tab` | cycle `agent` / `chat` / `orchestrate` |
| `Shift+Tab` | cycle edit mode |
| `Ctrl+R` | toggle verbose tool output |
| `Ctrl+U` | clear current input |
| `Esc` | clear input, close pending state, or exit |

Permission prompts:

| Key | Behavior |
| --- | --- |
| `Left` / `Right` | select `Allow once`, `Always allow`, or `Deny` |
| `Enter` | confirm selected action |
| `Esc` | deny |

liliMiMO pet:

```text
/pet
```

`/pet` toggles the mascot. It is rendered only in the live idle region, not written into message history or terminal scrollback.

## Commands

Session:

| Command | Aliases | Description |
| --- | --- | --- |
| `/new` | `/reset` | start a fresh session |
| `/save [name]` | - | save session marker |
| `/load <name>` | - | load session marker |
| `/sessions` | `/ls` | list saved sessions |
| `/quit` | `/exit`, `/q` | exit |

Context:

| Command | Aliases | Description |
| --- | --- | --- |
| `/compact` | - | show context compaction status |
| `/context` | `/ctx` | show context usage |
| `/undo` | - | undo last staged edit |
| `/redo` | - | redo last undone edit |
| `/memory` | `/mem` | show project memory location |

View and workflow:

| Command | Aliases | Description |
| --- | --- | --- |
| `/copy` | - | copy last assistant reply via OSC 52 |
| `/diff` | - | show inline diff status |
| `/plan` | - | show current plan summary |
| `/mode <agent\|chat\|orchestrate>` | - | switch mode |
| `/orchestrate <request>` | `/pipeline`, `/orch` | run W0-W4 pipeline with W3.5 mission check |
| `/pet` | - | toggle liliMiMO mascot |
| `/clear` | `/cls` | clear chat stream |
| `/verbose` | `/v` | toggle verbose output |

System:

| Command | Aliases | Description |
| --- | --- | --- |
| `/permission <mode>` | `/approval`, `/appr`, `/perm` | set `read-only`, `auto-edit`, or `full-auto` |
| `/editmode <mode>` | - | set `review`, `auto`, or `yolo` |
| `/run <cmd>` | - | request a shell command with approval |
| `/mcp` | - | show MCP server status |
| `/status` | - | show session summary |
| `/tools` | - | list available tools |
| `/model` | - | show active model |
| `/skill` | - | skill command placeholder |
| `/config` | `/cfg` | show config summary |
| `/init` | - | create `.minimum/config.json` |
| `/help` | `/?` | show help |

## Orchestration Pipeline

`/orchestrate <request>` routes a task through `PipelineBridge` and `MiMoPipeline`.

| Phase | Purpose |
| --- | --- |
| `W0` | compile a coarse task DAG |
| `W0.5` | refine task contracts, allowed globs, acceptance criteria, and optional context packs |
| `W1` | perception and context gathering |
| `W2/3` | implementation, tests, debugging, review, docs |
| `W3.5` | inline `mission_checker` acceptance loop |
| `W4` | finalize reports and memory decisions |

W3.5 can approve the mission, request human confirmation, or create one repair loop back through W1/W0.5/W2/3. The mission checker is an inline prompt loaded from `src/personas/prompts/mission_checker.md`; it is not registered as a normal assignable persona.

### Personas

The assignable persona registry contains 10 roles:

| Persona | Model | Notes |
| --- | --- | --- |
| `master_planner` | `mimo-v2.5-pro` | DAG, refinement guidance, finalization |
| `vision` | `mimo-v2.5` | image/perception reads |
| `repo_scout` | `mimo-v2.5` | repository discovery |
| `context_builder` | `mimo-v2.5-pro` | standalone context packs |
| `code_executor` | `mimo-v2.5` | implementation |
| `test_writer` | `mimo-v2.5` | tests |
| `test_runner` | `mimo-v2.5` | executes tests without modifying code |
| `runtime_debug` | `mimo-v2.5` | runtime failure analysis |
| `reviewer` | `mimo-v2.5` | review and risk finding |
| `docs` | `mimo-v2.5` | documentation updates |

Each persona has its own tool allowlist, denylist, write policy, max steps, token budget, output schema, and concurrency limits.

### Pipeline Artifacts

Pipeline state is persisted under `.minimum/tasks/<epic>/`:

```text
.minimum/tasks/<epic>/
├── dag.json
├── refinements/<pass>.json
├── contracts/<pass>.json
├── context-packs/<taskId>.md
├── mission-checks/<n>.md
├── mission-checks/<n>.json
└── repair-dags/<n>.json
```

W3.5 receives artifact paths and summaries so mission checking is traceable to disk, not only in-memory objects.

## Memory

Minimum uses deterministic project memory instead of vector retrieval.

Important files:

| Path | Role |
| --- | --- |
| `.minimum/manifest.yaml` | canonical memory manifest |
| `.minimum/*.md` | long-lived canonical memory sections |
| `.minimum/_staging/*.memory.md` | worker memory candidates |
| `.minimum/_archive/` | archived memory entries |
| `.minimum/index.json` | rebuildable index for canonical files, staging candidates, context packs, and pipeline artifacts |

The index records kind, id/key, path, file size, mtime, markdown headings, tags, scope, and related files. It is refreshed after memory and artifact writes.

## Repository Layout

```text
minimum/
├── bin/                     # CLI entrypoints
├── src/                     # engine, tools, memory, orchestration
│   ├── approval/            # approval modes and decisions
│   ├── bridge/              # EngineBridge and PipelineBridge
│   ├── config/              # config loading and defaults
│   ├── loop/                # MiMoLoop
│   ├── memory/              # project/session/runtime memory and governance
│   ├── orchestration/       # pipeline, contracts, scheduler, artifacts
│   ├── personas/            # persona registry and prompts
│   ├── tools/               # file, search, git, web, todo, shell tools
│   └── validators/          # syntax/type/pattern validation
├── tui/                     # Ink UI package
│   ├── src/components/      # visual components
│   ├── src/state/           # reducer, events, store
│   ├── src/app.tsx          # main TUI composition
│   └── verify.mjs           # headless render smoke checks
├── scripts/                 # build and asset-copy scripts
├── tests/                   # Vitest unit/integration tests
├── docs/                    # implementation plans and checklists
└── doc/                     # design notes and reports
```

## Development

Root package:

```bash
npm install
npm run build
npm test
npm run typecheck
npm run lint
```

TUI package:

```bash
cd tui
npm install
npm run build
npm run verify
```

Useful targeted commands:

```bash
node tui/verify.mjs
node bin/minimum-ink.js
```

PowerShell equivalents:

```powershell
npm run build
npm test
npm run typecheck

Set-Location .\tui
npm run build
npm run verify
Set-Location ..

node .\bin\minimum-ink.js
```

## Public API

The root package exports engine primitives from `src/index.ts`, including:

- `MiMoClient`
- `MiMoLoop`
- tool registry and built-in tools
- approval manager
- memory stores
- command registry
- validators
- orchestration helpers

The recommended user-facing interface is still the TUI command `minimum`.

## License

[MIT License](LICENSE)

## Acknowledgements

Minimum was shaped by ideas from resonix, pi code, CodeWhale, and the MiMo model/tooling ecosystem.
