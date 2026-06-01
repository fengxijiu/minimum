# minimum — Architecture & Function Structure

> Generated from source analysis of `claude/beautiful-thompson-PeUfL`.  
> Root package: `src/` · TUI package: `tui/src/`

---

## Table of Contents

1. [Directory Tree](#1-directory-tree)
2. [System Architecture](#2-system-architecture)
3. [Core Engine — MiMoLoop](#3-core-engine--mimoloop)
4. [Event Pipeline — LoopEvent → UiEvent](#4-event-pipeline--loopevent--uievent)
5. [Public API — Module by Module](#5-public-api--module-by-module)
6. [Tool Inventory](#6-tool-inventory)
7. [Config Schema](#7-config-schema)
8. [TUI Component Tree](#8-tui-component-tree)
9. [Dependency Graph](#9-dependency-graph)
10. [Wired vs Disconnected Modules](#10-wired-vs-disconnected-modules)
11. [Test Coverage](#11-test-coverage)

---

## 1. Directory Tree

```
src/                              ~12,600 lines
├── approval/          199 ln     ApprovalManager, types
├── bridge/             96 ln     EngineBridge, event mapping
├── capacity/          145 ln     CapacityController, types
├── clients/           367 ln     MiMoClient (SSE streaming)
├── commands/          934 ln     CommandRegistry + 10 command classes
├── completeness/      349 ln     CompletenessChecker + 4 sub-checkers
├── config/            324 ln     MiMoConfig, createMiMoStack, loadMiMoConfig
├── context/           407 ln     ContextManager, MessageFolder, KeyInfoExtractor, SummaryGenerator
├── hooks/             183 ln     HookManager, event types
├── index/             514 ln     SemanticIndex, Chunker, EmbeddingProviders
├── iteration/         375 ln     IterationManager, ErrorRecorder, FixRecorder, RetryStrategy
├── loop/            1,018 ln     MiMoLoop (810 ln), ReadTracker, SnapshotManager, EventDispatcher
├── lsp/               282 ln     PersistentTscDiagnostics (in-process ts.LanguageService)
├── mcp/               359 ln     McpClient, McpManager, types
├── memory/            397 ln     MemoryStore, SessionMemory, ProjectMemory, RuntimeMemory
├── mocks/             548 ln     Test doubles for all major components
├── repair/            498 ln     ToolCallRepair, StormBreaker, JsonRepair, PathRepair, TypeRepair
├── session/           254 ln     SessionManager, CheckpointManager
├── skills/            264 ln     SkillRegistry, SkillLoader, 4 builtin skills
├── subagent/          224 ln     SubAgent, SubAgentManager
├── tasks/             420 ln     TaskQueue, TaskManager
├── telemetry/         170 ln     TelemetryManager
├── tools/           1,164 ln
│   ├── filesystem/              ReadFileTool, WriteFileTool, EditFileTool, ApplyPatchTool, GlobTool, ListDirectoryTool
│   ├── git/                     GitTool, GitStatusTool, GitDiffTool, GitLogTool
│   ├── search/                  GrepTool, SearchTool
│   ├── shell/                   ExecShellTool
│   ├── todo/                    TodoWriteTool
│   └── ToolRegistry.ts
├── transcript/        194 ln     TranscriptManager
├── types/             449 ln     Shared interfaces (common, validator, completeness, context, repair, iteration)
├── utils/             489 ln     json-repair, token-counter, syntax-checker, path-utils, similarity
└── validators/        402 ln     CodeValidator, SyntaxChecker, TscChecker, TypeChecker, PatternChecker

tui/src/                        ~1,400 lines
├── components/        777 ln
│   ├── atoms.tsx                 ToolLine, DiffBlock, ChipsRow, PermissionCard, ErrorBlock, TokenMeter
│   ├── ChatStream.tsx
│   ├── CommandPalette.tsx
│   ├── ContextRail.tsx
│   ├── FilePicker.tsx
│   ├── HelpOverlay.tsx
│   ├── PlanStrip.tsx
│   ├── Prompt.tsx
│   ├── StatusBar.tsx
│   ├── TitleBar.tsx
│   └── WelcomeScreen.tsx
├── app.tsx            250 ln     Root component, full state machine
├── cli.tsx              8 ln     Entry point — creates runner and renders <App />
├── commands.ts        231 ln     Slash command registry and dispatcher
├── engine.ts          101 ln     Runner interface, UiEvent types, createEngineRunner
├── mock.ts             65 ln     Seed state for standalone / dev mode
├── theme.ts            22 ln     Color palette tokens
└── types.ts            67 ln     AppState, Message, ToolCall, Chip, Permission, ApprovalMode
```

---

## 2. System Architecture

```
User Input (CLI or TUI Prompt)
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│  Entry Points                                                 │
│  tui/src/cli.tsx  →  createEngineRunner()  →  <App runner />  │
│  bin/minimum-tui.js  →  createMiMoStack()  →  loop.run()      │
└────────────────────────┬──────────────────────────────────────┘
                         │  Runner.send(input): AsyncIterable<UiEvent>
                         ▼
┌───────────────────────────────────────────────────────────────┐
│  EngineBridge  (src/bridge/EngineBridge.ts)                   │
│  LoopEvent  ──►  mapLoopEvent()  ──►  UiEvent                 │
│  15 LoopEvent variants  →  7 UiEvent kinds  (null = dropped)  │
└────────────────────────┬──────────────────────────────────────┘
                         │  AsyncGenerator<LoopEvent>
                         ▼
┌───────────────────────────────────────────────────────────────┐
│  MiMoLoop  (src/loop/MiMoLoop.ts, 810 lines)                  │
│                                                               │
│  run(userInput) ──► stream of LoopEvent                       │
│                                                               │
│  Per step:                                                    │
│   1  steerQueue drain         ──► steer_accepted              │
│   2  budget / abort check                                     │
│   3  ContextManager.optimize  ──► context_optimized           │
│   4  CapacityController.obs   ──► capacity                    │
│   5  IStreamingClient.streamChat                              │
│        ──► content / reasoning / tool_call                    │
│   6  For each tool call:                                      │
│       ├ StormBreaker.inspect (suppress repeats)               │
│       ├ ReadTracker.guardEdit (read-before-write)             │
│       ├ plan mode block       ──► plan_blocked                │
│       ├ IHookManager PreToolUse  ──► hook (may block)         │
│       ├ IApprovalManager.checkApproval                        │
│       ├ SnapshotManager.snapshot (save file)                  │
│       ├ IToolHost.execute     ──► tool_result                 │
│       ├ IHookManager PostToolUse ──► hook                     │
│       ├ ReadTracker.markRead                                  │
│       └ ICodeValidator.validate  ──► validation + rollback    │
│   7  ICompletenessChecker.check  ──► completeness             │
│   8  IHookManager Stop        ──► hook                        │
│   9  yield done + usage                                       │
└──────────────────┬──────────────────────────────┬────────────┘
   injected via    │  MiMoLoopConfig               │
   createMiMoStack │                               │
    ┌──────────────┼───────────────┐               │
    ▼              ▼               ▼               ▼
StormBreaker   ReadTracker   SnapshotManager  CapacityController
(repair/)      (loop/)       (loop/)          (capacity/)
```

---

## 3. Core Engine — MiMoLoop

### Config Interface

```typescript
interface MiMoLoopConfig {
  // Typed collaborators (no more `any`)
  client:               IStreamingClient;       // streamChat() → AsyncIterable<StreamChunk>
  tools:                IToolHost;              // getDefinitions() + execute()
  validator?:           ICodeValidator;         // post-write tsc diagnostics + rollback
  toolRepair?:          IToolCallRepair;        // 4-stage JSON / schema repair
  completenessChecker?: ICompletenessChecker;  // structural TODO/stub detection
  contextManager?:      IContextManager;        // token fold / compress
  hookManager?:         IHookManager;           // PreToolUse / PostToolUse / Stop hooks
  approvalManager?:     IApprovalManager;       // three-tier tool gating

  // Primitive config
  capacity?:        Partial<CapacityConfig>;
  storm?:           { windowSize?: number; threshold?: number };
  enableReadGuard?: boolean;     // default true — blocks blind edits
  planMode?:        boolean;     // default false — read-only lock
  maxTokens?:       number;      // default 131 072
  maxSteps?:        number;      // default 50
  budgetUsd?:       number;      // default 0 = unlimited
  workingDirectory: string;
  thinking?:        { type: 'enabled' | 'disabled'; budget_tokens?: number };
}
```

### Public Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `run` | `(userInput: string): AsyncGenerator<LoopEvent>` | Main agentic loop — stream all events |
| `steer` | `(text: string): void` | Inject a mid-turn guidance message via steerQueue |
| `abort` | `(): void` | Cancel current execution via AbortController |
| `getState` | `(): LoopState` | Snapshot of step / token / cost / error counters |
| `getMessages` | `(): ChatMessage[]` | Current conversation history |
| `addSystemMessage` | `(content: string): void` | Prepend a system message |
| `configure` | `(config: Partial<MiMoLoopConfig>): void` | Live config patch |

### Private Methods

| Method | Purpose |
|--------|---------|
| `callModel()` | Stream from `IStreamingClient`, accumulate content / reasoning / tool_calls / usage |
| `applyCapacityAction(snapshot, step)` | Act on `targeted_refresh` (fold context) or `verify_and_replan` (inject steer) |
| `runHooks(event, ctx)` | Execute lifecycle hooks; block tool execution on `PreToolUse` failure |
| `safeParseArgs(toolCall)` | JSON.parse with `{}` fallback |
| `optimizeContext()` | Delegate to `IContextManager.optimize()` and replace `this.messages` |
| `getOptimizedMessages()` | Return current message list (seam for future compression) |
| `repairToolCalls(calls)` | 4-stage repair pipeline → truncation fix → schema coercion |
| `repairJson(str)` | Close brackets, remove trailing commas, fill dangling keys |
| `executeTool(toolCall)` | Delegate to `IToolHost.execute()`, wrap errors |
| `isMutatingTool(call)` | `write_file \| edit_file \| exec_shell \| git_commit \| git_push` |
| `isStormExemptTool(call)` | `read_file \| list_directory \| git_status \| git_diff` |

### LoopEvent Union Type

```typescript
type LoopEvent =
  | { type: 'content';           content: string }
  | { type: 'reasoning';         content: string }
  | { type: 'tool_call';         toolCall: ToolCall; repaired: boolean }
  | { type: 'tool_result';       toolCall: ToolCall; result: any; success: boolean }
  | { type: 'validation';        result: any }
  | { type: 'completeness';      result: any }
  | { type: 'context_optimized'; result: any }
  | { type: 'iteration';         attempt: number; maxAttempts: number; error?: string }
  | { type: 'usage';             usage: any }
  | { type: 'capacity';          snapshot: CapacitySnapshot }
  | { type: 'hook';              event: string; results: any[] }
  | { type: 'plan_blocked';      toolCall: ToolCall }
  | { type: 'error';             error: string; recoverable: boolean }
  | { type: 'done';              success: boolean; result?: string }
  | { type: 'steer_accepted';    content: string };
```

---

## 4. Event Pipeline — LoopEvent → UiEvent

`mapLoopEvent()` in `src/bridge/EngineBridge.ts` converts every `LoopEvent` to a `UiEvent` or `null` (dropped).

| LoopEvent `type` | UiEvent `kind` | Notes |
|-----------------|----------------|-------|
| `content` | `assistant` | `text = content` |
| `reasoning` | `reasoning` | `text = content` |
| `tool_call` | `tool` | `name, args` extracted from `toolCall.function` |
| `tool_result` | `tool_result` | `ok = success, content = result.content` |
| `validation` | `notice:warn` | Only when `!result.passed`; otherwise `null` |
| `completeness` | `notice:warn` | Only when `!result.complete`; otherwise `null` |
| `context_optimized` | `notice:info` | Only when `result.folded`; otherwise `null` |
| `capacity` | `notice:warn` | Only when `action !== 'no_intervention'`; otherwise `null` |
| `hook` | `notice:info` | `text = "hook · {event}"` |
| `plan_blocked` | `notice:warn` | `text = "plan mode blocked {name}"` |
| `iteration` | `notice:info` | `text = "retry {attempt}/{maxAttempts}"` |
| `steer_accepted` | `notice:info` | `text = "steer: {content}"` |
| `usage` | **null** | Dropped — telemetry only |
| `error` | `error` | `text = error` |
| `done` | `done` | `success` passed through |

### UiEvent Union Type

```typescript
type UiEvent =
  | { kind: 'assistant';   text: string }
  | { kind: 'reasoning';   text: string }
  | { kind: 'tool';        name: string; args: string }
  | { kind: 'tool_result'; name: string; ok: boolean; content: string }
  | { kind: 'notice';      text: string; tone: 'info' | 'warn' | 'ok' }
  | { kind: 'error';       text: string }
  | { kind: 'done';        success: boolean };
```

---

## 5. Public API — Module by Module

### `src/config/createMiMoStack.ts`

```typescript
function createMiMoStack(
  client:           IStreamingClient,
  tools:            IToolHost,
  workingDirectory: string,
  userConfig?:      MiMoConfig,
  deps?:            { hookManager?: IHookManager; approvalManager?: ApprovalManager }
): MiMoStack

interface MiMoStack {
  loop:            MiMoLoop;
  validator:       CodeValidator;
  contextManager:  ContextManager;
  approvalManager: ApprovalManager;
}
```

Auto-registers `TodoWriteTool` and `ApplyPatchTool` into the tools registry.  
Auto-builds `ApprovalManager` from `userConfig.approvalMode` unless `deps.approvalManager` is provided.

---

### `src/approval/ApprovalManager.ts`

```typescript
class ApprovalManager {
  constructor(config?: Partial<ApprovalConfig>)
  requestApproval(tool: string, args: Record<string, any>, description: string): Promise<ApprovalRequest>
  checkApproval(request: ApprovalRequest): Promise<ApprovalResponse>
  recordApproval(request: ApprovalRequest, approved: boolean, remember?: boolean): void
  rememberHabit(toolName: string, decision: 'always' | 'block'): void
  clearHabits(): void
  getMode(): ApprovalMode
  setMode(mode: ApprovalMode): void
  getConfig(): ApprovalConfig
  updateConfig(config: Partial<ApprovalConfig>): void
}

type ApprovalMode = 'read-only' | 'auto-edit' | 'full-auto' | 'suggest' | 'never'
//                  ^ blocks writes  ^ allows file edits  ^ unrestricted
```

**Mode decision matrix:**

| Mode | Read tools | File edits | Shell |
|------|-----------|-----------|-------|
| `read-only` | ✅ | ❌ | ❌ |
| `auto-edit` | ✅ | ✅ auto | ❌ needs confirm |
| `full-auto` | ✅ | ✅ | ✅ |
| `suggest` | ✅ auto (low-risk) | ❌ needs confirm | ❌ needs confirm |
| `never` | ❌ | ❌ | ❌ |

Habit cache overrides all mode decisions. Per-call history is separate from per-tool habits.

---

### `src/clients/MiMoClient.ts`

```typescript
class MiMoClient {
  constructor(options?: MiMoClientOptions)
  streamChat(options: ChatOptions): AsyncIterable<StreamChunk>
  chat(options: ChatOptions): Promise<ChatResponse>
  getConfig(): MiMoClientOptions
}

type StreamChunk =
  | { type: 'content';  content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'usage';    usage: { promptTokens: number; completionTokens: number; totalTokens: number } }
  | { type: 'done' }
  | { type: 'error';   error: string }
```

---

### `src/validators/CodeValidator.ts`

```typescript
class CodeValidator implements ICodeValidator {
  constructor(options?: { enabledCheckers?: string[] })
  validate(request: ValidationRequest): Promise<ValidationResult>
  registerChecker(checker: IChecker): void
}

// Built-in checkers (registered by CodeValidator):
//   SyntaxChecker  — AST parse errors
//   TscChecker     — delegates to PersistentTscDiagnostics (in-process ts.LanguageService)
//   TypeChecker    — pattern-based type heuristics
//   PatternChecker — banned patterns (console.log, TODO counts, etc.)
```

---

### `src/lsp/PersistentTscDiagnostics.ts`

```typescript
async function getTsDiagnostics(
  filePath: string,   // absolute path of edited file
  workDir:  string,   // project root (for tsconfig resolution)
): Promise<ValidationCheck[]>
```

Maintains a singleton `Map<workDir, ts.LanguageService>`. First call per workDir: ~300 ms (tsconfig read + compiler init). Subsequent calls: ~10 ms (re-parse changed file only). Falls back to `[]` if `typescript` package is unavailable.

---

### `src/repair/ToolCallRepair.ts`

```typescript
class ToolCallRepair implements IToolCallRepair {
  repair(request: RepairRequest): Promise<RepairResult>
  repairJson(json: string): JsonRepairResult
  repairArgTypes(args: Record<string, any>, schema: ToolSchema): Record<string, any>
  repairArgValues(args: Record<string, any>, context: RepairContext): Record<string, any>
  repairPath(path: string, context: RepairContext): string
}
```

4-stage pipeline: JSON parse → truncation fix (`repairJson`) → schema type coercion → value normalisation.

---

### `src/repair/StormBreaker.ts`

Detects repeated identical tool calls within a sliding window. Configured via `storm.windowSize` and `storm.threshold` in `MiMoConfig`. Exempt tools (`read_file`, `git_status`, etc.) are never suppressed.

---

### `src/context/ContextManager.ts`

```typescript
class ContextManager implements IContextManager {
  constructor(options: ContextManagerOptions)
  optimize(request: { messages: ChatMessage[]; taskState: TaskState; maxTokens: number }): Promise<ContextOptimizeResult>
}
```

Folds middle messages when usage exceeds `foldThreshold` (0.70). Aggressive fold at `aggressiveThreshold` (0.75). Always keeps the tail (`tailFraction` = 25%) and system message.

---

### `src/capacity/CapacityController.ts`

```typescript
class CapacityController {
  constructor(config?: Partial<CapacityConfig>)
  isEnabled(): boolean
  observe(obs: CapacityObservation): CapacitySnapshot
  recordRefresh(step: number): void
}

type GuardrailAction = 'no_intervention' | 'targeted_refresh' | 'verify_and_replan'
```

Emits `targeted_refresh` when token usage crosses `mediumRiskMax` (0.62). Emits `verify_and_replan` when slack drops below `severeMinSlack` (−0.25). Respects `refreshCooldownTurns` (6) between actions.

---

### `src/loop/ReadTracker.ts`

```typescript
class ReadTracker {
  reset(): void
  markRead(filePath: string, workingDirectory: string): void
  guardEdit(filePath: string, workingDirectory: string): string | null  // null = OK, string = block reason
  getReadFiles(): string[]
}

function isReadTool(call: ToolCall): boolean   // read_file, list_directory, glob, grep
function isEditTool(call: ToolCall): boolean   // write_file, edit_file, apply_patch
```

---

### `src/loop/SnapshotManager.ts`

```typescript
class SnapshotManager {
  reset(): void
  snapshot(filePath: string, workingDirectory: string): Promise<void>
  restore(filePath: string, workingDirectory: string): Promise<boolean>
}
```

Called before each file edit. On validation failure, `MiMoLoop` calls `restore()` to revert the file and feeds diagnostics back to the model.

---

### `src/hooks/HookManager.ts`

```typescript
class HookManager {
  constructor(hooks?: HookConfig[])
  addHook(config: HookConfig): string            // returns hook id
  removeHook(id: string): boolean
  execute(event: HookEvent, context: HookContext): Promise<HookResult[]>
  getHooks(event?: HookEvent): Hook[]
}

type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop'
```

`PreToolUse` with `success: false` causes MiMoLoop to block the tool and inject the error into the model context.

---

### `src/memory/`

```typescript
class MemoryStore {
  write(entry: MemoryEntry): Promise<string>
  read(id: string): Promise<MemoryEntry | null>
  query(filter: Partial<MemoryEntry>): Promise<MemoryEntry[]>
  export(): Promise<string>
}

class SessionMemory    // volatile, in-memory, per-session
class ProjectMemory    // persisted to .mimo/memory/, scoped to project
class RuntimeMemory    // AppendOnlyLog + VolatileScratch + RuntimeMemory composite
```

---

### `src/mcp/`

```typescript
class McpClient {
  connect(config: McpServerConfig): Promise<void>
  listTools(): Promise<McpTool[]>
  callTool(name: string, args: Record<string, any>): Promise<McpToolResult>
  disconnect(): Promise<void>
}

class McpManager {
  addServer(config: McpServerConfig): string
  connect(id: string): Promise<void>
  callTool(serverId: string, name: string, args: Record<string, any>): Promise<McpToolResult>
  listAllTools(): Promise<McpTool[]>
}
```

Supports `stdio`, `sse`, and `http` transport types. **Not yet wired into `createMiMoStack`.** (P2 roadmap.)

---

### `src/subagent/`

```typescript
class SubAgent {
  constructor(config: SubAgentConfig)
  run(message: string): AsyncGenerator<LoopEvent>
  getState(): SubAgentState
  abort(): void
}

class SubAgentManager {
  spawn(config: SubAgentConfig): string          // returns agent id
  send(id: string, message: string): Promise<SubAgentState>
  list(): SubAgentState[]
  abort(id: string): void
}
```

**Not yet wired into `MiMoLoop`.** (P2 roadmap — parallel read-only subtasks.)

---

### `src/tasks/`

```typescript
class TaskQueue {
  push(task: TaskDefinition): string
  pop(): TaskDefinition | undefined
  peek(): TaskDefinition | undefined
  size(): number
  clear(): void
  waitForTask(taskId: string): Promise<TaskDefinition | undefined>
}

class TaskManager {
  initialize(): Promise<void>
  createTask(definition: Omit<TaskDefinition, 'id' | 'createdAt'>): Promise<string>
  cancelTask(taskId: string): Promise<boolean>
  list(filter?: Partial<TaskDefinition>): TaskDefinition[]
}
```

**Not yet wired into `MiMoLoop`.** (P2 roadmap — background tasks.)

---

## 6. Tool Inventory

| Tool class | `name` | Key parameters | Notes |
|------------|--------|---------------|-------|
| `ReadFileTool` | `read_file` | `path`, `encoding?`, `startLine?`, `endLine?` | Line-range reads |
| `WriteFileTool` | `write_file` | `path`, `content`, `encoding?`, `createDirs?` | Creates parent dirs |
| `EditFileTool` | `edit_file` | `path`, `edits[]` (`{search, replace}`) | Array of replacements |
| `ApplyPatchTool` | `apply_patch` | `path`, `hunks[]` (`{search, replace}`) | Search must match exactly once |
| `GlobTool` | `glob` | `pattern`, `cwd?`, `ignore[]` | Respects .gitignore patterns |
| `ListDirectoryTool` | `list_directory` | `path`, `recursive?`, `showHidden?` | |
| `GitTool` | `git` | `subcommand`, `args?` | Generic git wrapper |
| `GitStatusTool` | `git_status` | `porcelain?` | |
| `GitDiffTool` | `git_diff` | `staged?`, `file?` | |
| `GitLogTool` | `git_log` | `limit?`, `oneline?` | |
| `GrepTool` | `grep` | `pattern`, `path?`, `include?`, `ignoreCase?`, `maxResults?` | |
| `SearchTool` | `search` | `query`, `type?` (`files\|content\|both`) | Combined search |
| `ExecShellTool` | `exec_shell` | `command`, `timeout?`, `cwd?` | Gated behind `MIMO_ENABLE_SHELL=1` |
| `TodoWriteTool` | `todo_write` | `todos[]` (`{content, status}`) | One `in_progress` max enforced |

### ToolRegistry Interface

```typescript
interface Tool {
  name: string;
  description: string;
  getDefinition(): ToolDefinition;
  execute(args: Record<string, any>, context?: { workingDirectory?: string; signal?: AbortSignal }): Promise<string>;
}

class ToolRegistry {
  register(tool: Tool): void
  unregister(name: string): boolean
  get(name: string): Tool | undefined
  getAll(): Tool[]
  has(name: string): boolean
  getDefinitions(): ToolDefinition[]
  execute(toolCall: { function: { name: string; arguments: string } }, context?: any): Promise<{ content: string; isError?: boolean }>
}
```

---

## 7. Config Schema

```typescript
interface MiMoConfig {
  maxTokens?:    number;   // default 131 072
  maxSteps?:     number;   // default 50
  budgetUsd?:    number;   // default 0 (no limit)

  enableReadGuard?: boolean;      // default true  — blocks edits without prior read
  planMode?:        boolean;      // default false — read-only lock, blocks mutations

  approvalMode?: 'read-only' | 'auto-edit' | 'full-auto' | 'suggest' | 'never';
  //              default: 'suggest'

  context?: {
    foldThreshold?:        number;  // default 0.70 — fold when 70% of tokens used
    aggressiveThreshold?:  number;  // default 0.75 — aggressive fold at 75%
    tailFraction?:         number;  // default 0.25 — keep 25% of tail messages
  };

  capacity?: {
    enabled?:              boolean; // default true
    lowRiskMax?:           number;  // default 0.50
    mediumRiskMax?:        number;  // default 0.62 — triggers targeted_refresh
    severeMinSlack?:       number;  // default -0.25 — triggers verify_and_replan
    refreshCooldownTurns?: number;  // default 6
  };

  storm?: {
    windowSize?: number;  // default 6 — sliding window for duplicate detection
    threshold?:  number;  // default 3 — suppress after 3 repeats in window
  };

  validation?: {
    enabled?:  boolean;   // default true
    syntax?:   boolean;   // default true — AST parse errors
    tsc?:      boolean;   // default true — in-process ts.LanguageService diagnostics
    pattern?:  boolean;   // default true — banned patterns, TODO counts
  };

  completeness?: {
    enabled?: boolean;    // default true — structural TODO/stub/ts-ignore detection
  };
}
```

**Loading priority:** `.mimo/config.json` → `.mimo.json` → `opencode.json` (translated from `minimum.optimization` schema).

---

## 8. TUI Component Tree

```
<App runner={Runner}>                          app.tsx
  state: AppState {
    messages, files, edits, plan, ctx,
    mode, approvalMode, path, branch
  }
  overlay: 'none' | 'cmd' | 'file'
  pending: null | 'permission' | 'error'
  │
  ├── <TitleBar path branch mode />            — top bar: file path · branch · mode label
  ├── <PlanStrip title steps />                — step kickers: 01·✓  04·●  05·○
  │
  ├── <Box row>
  │     ├── <ContextRail files edits mode />   — left rail: staged files + edits
  │     │
  │     └── <Box column flexGrow={1}>
  │           ├── <WelcomeScreen path />       — shown when no conversation yet
  │           │    OR
  │           ├── <ChatStream stepLabel messages />
  │           │     └── per message type:
  │           │           user       → plain text row
  │           │           assistant  → text with accent border
  │           │           system     → <SystemRow tone />
  │           │           tool       → <ToolLine kind args meta status />
  │           │           diff       → <DiffBlock file lines />
  │           │           chips      → <ChipsRow chips />
  │           │           permission → <PermissionCard tool cmd cwd note />
  │           │           error      → <ErrorBlock title lines />
  │           │
  │           ├── <HelpOverlay />              — ? key overlay
  │           ├── <CommandPalette items sel /> — / prefix overlay
  │           ├── <FilePicker items sel />     — @ prefix overlay
  │           │
  │           └── <Prompt value onChange onSubmit placeholder focus />
  │
  └── <StatusBar state approvalMode ctxUsed ctxMax hint />
        pill:  agent=cyan  paused=amber  error=red
        badge: [read-only]=amber  [auto-edit]=cyan  [full-auto]=green
        keys:  shift per state
```

### Component Props Reference

| Component | Props |
|-----------|-------|
| `App` | `runner?: Runner` |
| `TitleBar` | `path: string, branch: string, mode: string` |
| `PlanStrip` | `title: string, steps: PlanStep[]` |
| `ContextRail` | `files: FileEntry[], edits: StagedEdit[], mode: Mode` |
| `ChatStream` | `stepLabel: string, messages: Message[]` |
| `Prompt` | `value, onChange, onSubmit, placeholder, focus: boolean` |
| `CommandPalette` | `items: TuiCommand[], selected: number` |
| `FilePicker` | `items: FileEntry[], selected: number` |
| `WelcomeScreen` | `path?: string` |
| `StatusBar` | `state: SessionState, approvalMode?: ApprovalMode, ctxUsed, ctxMax, hint?` |
| `ToolLine` | `tool: ToolCall` |
| `DiffBlock` | `diff: Diff` |
| `ChipsRow` | `chips: Chip[]` |
| `PermissionCard` | `perm: Permission` |
| `ErrorBlock` | `error: ErrorReport` |
| `TokenMeter` | `used: number, max: number` |

### TUI Engine Seam

```typescript
// tui/src/engine.ts
interface Runner { send(input: string): AsyncIterable<UiEvent> }

// Two implementations:
const mockRunner: Runner          // standalone dev, no API key needed
createEngineRunner(cwd): Promise<Runner>  // real engine via dynamic import of ../../dist/index.js
                                          // falls back to mockRunner if MIMO_API_KEY unset or build absent
```

---

## 9. Dependency Graph

```
createMiMoStack
  ├── CodeValidator ──── TscChecker ─── PersistentTscDiagnostics (ts.LanguageService)
  │                  └─ SyntaxChecker, TypeChecker, PatternChecker
  ├── ContextManager ─── MessageFolder, KeyInfoExtractor, SummaryGenerator
  ├── CompletenessChecker ── FunctionChecker, ImportChecker, ErrorHandlingChecker, TaskCompletionChecker
  ├── ToolCallRepair ──── JsonRepair, PathRepair, TypeRepair, ValueRepair
  ├── ApprovalManager
  ├── TodoWriteTool
  ├── ApplyPatchTool
  └── MiMoLoop
        ├── StormBreaker
        ├── CapacityController
        ├── ReadTracker
        └── SnapshotManager

EngineBridge
  └── MiMoLoop (via EngineLoop interface)

tui/src/cli.tsx
  └── createEngineRunner()
        └── dynamic import: ../../dist/index.js
              └── createMiMoStack + EngineBridge  (Runner seam)
```

---

## 10. Wired vs Disconnected Modules

### ✅ Wired — active in every `createMiMoStack` call

| Module | Role |
|--------|------|
| `approval/ApprovalManager` | Three-tier tool gating |
| `capacity/CapacityController` | Token-budget guardrails |
| `completeness/CompletenessChecker` | Structural stub/TODO detection |
| `context/ContextManager` | Token fold / compress |
| `loop/MiMoLoop` | Central agentic engine |
| `loop/ReadTracker` | Read-before-write guard |
| `loop/SnapshotManager` | Pre-edit snapshot + rollback |
| `repair/StormBreaker` | Duplicate-call suppression |
| `repair/ToolCallRepair` | 4-stage JSON/schema repair |
| `tools/*` (all 14) | Agent-facing capabilities |
| `validators/CodeValidator` + `TscChecker` | Post-write diagnostics |
| `lsp/PersistentTscDiagnostics` | In-process TS LanguageService |

### ⚠️ Injectable — wired only when caller provides them

| Module | Config field | Behaviour when absent |
|--------|-------------|----------------------|
| `hooks/HookManager` | `deps.hookManager` | Hooks silently skipped |

### ❌ Disconnected — exported from `src/index.ts` but not used by the core factory

These are P2/P3 roadmap items ready to plug in:

| Module | Lines | Description | Next step |
|--------|-------|-------------|-----------|
| `mcp/McpClient + McpManager` | 359 | MCP tool servers (stdio/SSE/HTTP) | Wire into `ToolRegistry` at stack creation |
| `subagent/SubAgent + SubAgentManager` | 224 | Parallel child agents | Wire into `MiMoLoop` for parallel subtasks |
| `tasks/TaskQueue + TaskManager` | 420 | Background task scheduling | Wire into loop for async task dispatch |
| `index/SemanticIndex + Chunker` | 514 | Vector search over codebase | Wire into `ContextManager` for retrieval |
| `memory/*` (all 4 classes) | 397 | Multi-tier persistent memory | Wire into loop for cross-session context |
| `session/SessionManager + CheckpointManager` | 254 | Checkpoint save/restore | Wire into loop for crash recovery |
| `transcript/TranscriptManager` | 194 | Session replay / export | Wire into `run()` as an observer |
| `telemetry/TelemetryManager` | 170 | Usage stats, cost tracking | Wire into `usage` event handler |
| `skills/SkillRegistry + builtins` | 264 | Code-review / refactor skills | Wire into command dispatcher |
| `iteration/IterationManager` | 375 | Error-recovery retry loop | Incompatible with generator pattern; redesign needed |
| `commands/*` (10 classes) | 934 | CLI command infrastructure | Used by `bin/minimum-tui.js` directly |

---

## 11. Test Coverage

**20 test files · 186 tests · all passing**

| File | Tests | Coverage focus |
|------|-------|----------------|
| `unit/ToolCallRepair.test.ts` | 12 | JSON repair, truncation, schema coercion |
| `unit/ToolRegistry.test.ts` | 23 | Registration, execution, definition fetching |
| `unit/commands.test.ts` | 12 | Command registry, slash dispatch |
| `unit/completeness.test.ts` | 15 | Function, import, error-handling, task checkers |
| `unit/config.test.ts` | 8 | `loadMiMoConfig`, `opencode.json` bridge, `createMiMoStack` |
| `unit/context.test.ts` | 8 | Context fold, token counting |
| `unit/iteration.test.ts` | 9 | ErrorRecorder, FixRecorder, RetryStrategy |
| `unit/mcp.test.ts` | 13 | McpClient, server config, tool call round-trip |
| `unit/memory.test.ts` | 20 | MemoryStore, SessionMemory, ProjectMemory |
| `unit/p1-approval-patch.test.ts` | 13 | ApprovalManager (all 5 modes + habit cache), ApplyPatchTool |
| `unit/repair.test.ts` | 20 | JsonRepair, StormBreaker, ToolCallRepair pipeline |
| `unit/tools.test.ts` | 17 | File ops, git, grep, ExecShell |
| `unit/validators.test.ts` | 20 | SyntaxChecker, TypeChecker, PatternChecker, TscChecker |
| `integration/mimo-loop.test.ts` | 7 | Loop execution, event stream, usage counting |
| `integration/p0-wiring.test.ts` | 7 | P0 feature wiring: plan mode, hooks, EngineBridge |
| `integration/memory-persistence.test.ts` | 3 | Session save/load round-trip |
| `integration/session-workflow.test.ts` | 4 | Checkpoint, SessionManager |
| `integration/task-workflow.test.ts` | 7 | TaskQueue + TaskManager |
| `integration/transcript-replay.test.ts` | 5 | Record → replay → export |
| `helpers.test.ts` | — | Shared test utilities |

---

*Last updated: auto-generated from `claude/beautiful-thompson-PeUfL` · `minimum@1.0.0`*
