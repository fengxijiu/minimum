# Git Foundation — Phase 5: Worktree Write Routing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete worktree isolation by routing all LLM tool writes (file writes, path-policy checks, snapshot operations, shell working directory) to the task's git worktree path instead of the main `projectRoot`, so `WorktreeIsolator.commitAndApply()` can capture real changes.

**Architecture:** `WorkerLoop.executeOne()` already passes `workingDirectory: this.projectRoot` to every `IToolHost.execute()` call. Phase 4 creates the worktree but discards its path. Phase 5 stores that path (`activeWorktreePath`), threads it into `executeOne()` as an optional parameter, and replaces all 6 uses of `this.projectRoot` inside `executeOne()` with `effectiveRoot = worktreePath ?? this.projectRoot`. When `worktreeIsolation` is false, `worktreePath` is undefined and behaviour is identical to pre-Phase-4 code. No new primitives, no new files — one focused method signature change and 6 substitutions.

**Tech Stack:** TypeScript (ESM), Vitest, existing `WorkerLoop`, `WorktreeIsolator`, `IToolHost`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/orchestration/WorkerLoop.ts` | Store worktree path, add parameter to `executeOne`, use `effectiveRoot` |
| Create | `tests/unit/WorkerLoop.worktree.test.ts` | Verify `tools.execute` receives worktree path as `workingDirectory` |

---

## Task 1: Store worktree path and thread it to `executeOne`

**Files:**
- Modify: `src/orchestration/WorkerLoop.ts`
- Create: `tests/unit/WorkerLoop.worktree.test.ts`

### Background: what Phase 4 left

In `runTask()`, Phase 4 added (approximately line 258):
```typescript
await isolator.create(input.contract.taskId, worktreeBaseSha);
```
The return value (the worktree path string) is discarded. `activeWorktreePath` does not exist yet.

In `executeOne()`, every path-sensitive operation uses `this.projectRoot` (6 sites):
1. `checkWrite(targetPath, { ..., projectRoot: this.projectRoot })` — write-policy gate
2. `dependencyWriteTargets(args, this.projectRoot)` — install_dependency targets
3. `checkWrite(target, { ..., projectRoot: this.projectRoot })` — install_dependency write gate
4. `snapshots.snapshot(targetPath, this.projectRoot)` — pre-edit snapshot
5. `this.tools.execute(call, { ..., workingDirectory: this.projectRoot })` — tool execution
6. `snapshots.restore(targetPath, this.projectRoot)` — validation rollback

### Step-by-step

- [ ] **Step 1: Write the failing test**

Create `tests/unit/WorkerLoop.worktree.test.ts`:

```typescript
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IToolHost } from "../../src/loop/MiMoLoop.js";
import type { IStreamingClient } from "../../src/loop/MiMoLoop.js";
import type { ToolDefinition, ToolCall } from "../../src/types/common.js";
import { WorkerLoop } from "../../src/orchestration/WorkerLoop.js";
import { AgentGitStore } from "../../src/git/AgentGitStore.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-wl-wt-test-"));
  execFileSync("git", ["init"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A recording tool host: captures the `workingDirectory` passed to execute()
 * and immediately returns a non-error result so the loop can proceed.
 */
function makeRecordingToolHost(): {
  host: IToolHost;
  calls: Array<{ name: string; workingDirectory: string | undefined }>;
} {
  const calls: Array<{ name: string; workingDirectory: string | undefined }> = [];
  const host: IToolHost = {
    getDefinitions(): ToolDefinition[] {
      return [
        {
          name: "read_file",
          description: "read",
          parameters: { type: "object" as const, properties: {}, required: [] },
        },
      ];
    },
    async execute(
      toolCall: { function: { name: string; arguments: string } },
      context?: { signal?: AbortSignal; workingDirectory?: string },
    ) {
      calls.push({ name: toolCall.function.name, workingDirectory: context?.workingDirectory });
      return { content: "ok", isError: false };
    },
  };
  return { host, calls };
}

/**
 * A streaming client that emits one assistant turn with a single tool call,
 * then a second turn with plain text (no tool calls) to end the loop.
 */
function makeToolCallingClient(toolName: string, args: Record<string, unknown>): IStreamingClient {
  let turn = 0;
  return {
    streamChat() {
      turn++;
      if (turn === 1) {
        // First turn: assistant calls the tool
        return (async function* () {
          yield {
            type: "tool_call" as const,
            toolCall: {
              id: "tc-1",
              function: { name: toolName, arguments: JSON.stringify(args) },
            },
          };
          yield { type: "done" as const };
        })();
      }
      // Second turn: assistant produces final text
      return (async function* () {
        yield {
          type: "content" as const,
          content: "<task_report><status>completed</status><summary>done</summary></task_report>",
        };
        yield { type: "done" as const };
      })();
    },
  };
}

describe("WorkerLoop worktree write routing", () => {
  it("passes projectRoot as workingDirectory when worktreeIsolation is false", async () => {
    const { host, calls } = makeRecordingToolHost();
    const client = makeToolCallingClient("read_file", { path: "readme.txt" });

    const loop = new WorkerLoop({
      client,
      tools: host,
      projectRoot: tmpDir,
      worktreeIsolation: false,
    });

    const persona = {
      id: "code_writer" as const,
      name: "Code Writer",
      systemPrompt: "you are a coder",
      toolAllowlist: ["read_file"],
      alwaysAllowedGlobs: ["**/*"],
      maxTokens: 1000,
    };

    await loop.runTask({
      systemPrompt: "test",
      userPrompt: "read readme",
      persona,
      contract: {
        taskId: "t1",
        personaId: "code_writer",
        title: "test",
        prompt: "test",
        allowedGlobs: ["**/*"],
        dependencies: [],
      },
      maxSteps: 5,
    });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.workingDirectory).toBe(tmpDir);
  });

  it("passes the worktree path as workingDirectory when worktreeIsolation is true", async () => {
    // Ensure the repo has at least one commit so worktree add works
    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await store.commitTree(
      [{ relativePath: "seed.txt", content: "seed" }],
      "initial",
    );
    await store.setRef("refs/heads/main", baseSha);
    // Point HEAD at the branch so git worktree add can use it
    execFileSync("git", ["checkout", "-b", "main"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["reset", "--hard", baseSha], { cwd: tmpDir, stdio: "ignore" });

    const { host, calls } = makeRecordingToolHost();
    const client = makeToolCallingClient("read_file", { path: "seed.txt" });

    const loop = new WorkerLoop({
      client,
      tools: host,
      projectRoot: tmpDir,
      worktreeIsolation: true,
    });

    const persona = {
      id: "code_writer" as const,
      name: "Code Writer",
      systemPrompt: "you are a coder",
      toolAllowlist: ["read_file"],
      alwaysAllowedGlobs: ["**/*"],
      maxTokens: 1000,
    };

    await loop.runTask({
      systemPrompt: "test",
      userPrompt: "read seed",
      persona,
      contract: {
        taskId: "t2",
        personaId: "code_writer",
        title: "test",
        prompt: "test",
        allowedGlobs: ["**/*"],
        dependencies: [],
      },
      maxSteps: 5,
    });

    expect(calls.length).toBeGreaterThan(0);
    // workingDirectory must NOT be tmpDir — it should be the worktree path
    expect(calls[0]!.workingDirectory).not.toBe(tmpDir);
    // The worktree path should exist (or have existed — may be cleaned up already)
    // and should be a temp path containing "minimum-wt-"
    expect(calls[0]!.workingDirectory).toContain("minimum-wt-");
  });
});
```

- [ ] **Step 2: Run the test — confirm 2 tests fail (or the second fails)**

```
npx vitest run tests/unit/WorkerLoop.worktree.test.ts
```
Expected: second test fails (worktree path is `tmpDir`, not the worktree path).

- [ ] **Step 3: Store worktree path in `runTask()`**

In `src/orchestration/WorkerLoop.ts`, find the Phase 4 isolator setup block. Currently:

```typescript
let worktreeBaseSha: string | null = null;
const isolator = this.worktreeIsolation
  ? new WorktreeIsolator(gitStore)
  : null;

if (isolator) {
  try {
    worktreeBaseSha = await gitStore.readRef("HEAD");
    if (!worktreeBaseSha) {
      worktreeBaseSha = await gitStore.commitTree(
        [{ relativePath: ".minimum-init", content: "" }],
        "chore: initialize minimum object store",
      );
      await gitStore.setRef("refs/minimum/init", worktreeBaseSha);
    }
    await isolator.create(input.contract.taskId, worktreeBaseSha);
  } catch {
    // Worktree creation failed — proceed without isolation.
    worktreeBaseSha = null;
  }
}
```

Change to (add `activeWorktreePath` variable and store the return value):

```typescript
let worktreeBaseSha: string | null = null;
let activeWorktreePath: string | undefined;
const isolator = this.worktreeIsolation
  ? new WorktreeIsolator(gitStore)
  : null;

if (isolator) {
  try {
    worktreeBaseSha = await gitStore.readRef("HEAD");
    if (!worktreeBaseSha) {
      worktreeBaseSha = await gitStore.commitTree(
        [{ relativePath: ".minimum-init", content: "" }],
        "chore: initialize minimum object store",
      );
      await gitStore.setRef("refs/minimum/init", worktreeBaseSha);
    }
    activeWorktreePath = await isolator.create(input.contract.taskId, worktreeBaseSha);
  } catch {
    // Worktree creation failed — proceed without isolation.
    worktreeBaseSha = null;
    activeWorktreePath = undefined;
  }
}
```

- [ ] **Step 4: Pass `activeWorktreePath` to `executeOne`**

In the same `runTask()` method, find where `executeOne` is called (inside the `for (const call of turn.toolCalls)` loop). Currently:

```typescript
const outcome = await this.executeOne(
  call,
  input.persona,
  input.contract,
  input.signal,
  snapshots,
  emit,
  pendingStaticCompileCommands,
);
```

Change to:

```typescript
const outcome = await this.executeOne(
  call,
  input.persona,
  input.contract,
  input.signal,
  snapshots,
  emit,
  pendingStaticCompileCommands,
  activeWorktreePath,
);
```

- [ ] **Step 5: Add `worktreePath?` parameter to `executeOne` and apply `effectiveRoot`**

Find the `executeOne` method signature. Currently:

```typescript
private async executeOne(
  call: ToolCall,
  persona: Persona,
  contract: TaskContract,
  signal: AbortSignal | undefined,
  snapshots: GitSnapshotManager,
  emit: (e: WorkerEvent) => void,
  pendingStaticCompileCommands: Set<string>,
): Promise<ExecuteOutcome>
```

Change to:

```typescript
private async executeOne(
  call: ToolCall,
  persona: Persona,
  contract: TaskContract,
  signal: AbortSignal | undefined,
  snapshots: GitSnapshotManager,
  emit: (e: WorkerEvent) => void,
  pendingStaticCompileCommands: Set<string>,
  worktreePath?: string,
): Promise<ExecuteOutcome>
```

At the very top of the method body (before `const name = call.function.name`), add:

```typescript
// Use worktree path for all file operations when isolation is active.
const effectiveRoot = worktreePath ?? this.projectRoot;
```

Then replace all 6 occurrences of `this.projectRoot` within `executeOne` with `effectiveRoot`:

**Site 1** — write-policy gate (`checkWrite`):
```typescript
// Before:
const decision = checkWrite(targetPath, {
  persona,
  contract,
  projectRoot: this.projectRoot,
});
// After:
const decision = checkWrite(targetPath, {
  persona,
  contract,
  projectRoot: effectiveRoot,
});
```

**Site 2** — `dependencyWriteTargets`:
```typescript
// Before:
const writeTargets = dependencyWriteTargets(args, this.projectRoot);
// After:
const writeTargets = dependencyWriteTargets(args, effectiveRoot);
```

**Site 3** — `checkWrite` inside the install_dependency loop:
```typescript
// Before:
const decision = checkWrite(target, {
  persona,
  contract,
  projectRoot: this.projectRoot,
});
// After:
const decision = checkWrite(target, {
  persona,
  contract,
  projectRoot: effectiveRoot,
});
```

**Site 4** — pre-edit snapshot:
```typescript
// Before:
await snapshots.snapshot(targetPath, this.projectRoot);
// After:
await snapshots.snapshot(targetPath, effectiveRoot);
```

**Site 5** — `tools.execute` working directory:
```typescript
// Before:
const result = await this.tools.execute(call, {
  ...(signal !== undefined && { signal }),
  workingDirectory: this.projectRoot,
});
// After:
const result = await this.tools.execute(call, {
  ...(signal !== undefined && { signal }),
  workingDirectory: effectiveRoot,
});
```

**Site 6** — validation rollback (`snapshots.restore`):
```typescript
// Before:
const restored = await snapshots.restore(
  targetPath,
  this.projectRoot,
);
// After:
const restored = await snapshots.restore(
  targetPath,
  effectiveRoot,
);
```

- [ ] **Step 6: TypeScript check**

```
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 7: Run the worktree routing tests**

```
npx vitest run tests/unit/WorkerLoop.worktree.test.ts
```
Expected: 2 passed.

> **Note:** If the `makeToolCallingClient` mock causes issues with how `WorkerLoop` processes stream chunks, inspect the chunk format expected by `streamOneTurn`. The client must yield `{ type: "tool_call", toolCall: { id: string, function: { name, arguments } } }` and then `{ type: "done" }`. Adjust accordingly.

- [ ] **Step 8: Run Phase 4 tests — no regressions**

```
npx vitest run tests/unit/AgentGitStore.test.ts tests/unit/WorktreeIsolator.test.ts tests/unit/ResourceManager.test.ts
```
Expected: 29 passed.

- [ ] **Step 9: Commit**

```bash
git add src/orchestration/WorkerLoop.ts tests/unit/WorkerLoop.worktree.test.ts
git commit -m "feat(orchestration): route tool writes to worktree path when isolation is active"
```

---

## Task 2: Final verification

**Files:**
- No changes — audit only

- [ ] **Step 1: TypeScript build**

```
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 2: All Phase 4+5 tests**

```
npx vitest run tests/unit/AgentGitStore.test.ts tests/unit/WorktreeIsolator.test.ts tests/unit/ResourceManager.test.ts tests/unit/WorkerLoop.worktree.test.ts
```
Expected: 31 passed (29 Phase 4 + 2 Phase 5).

- [ ] **Step 3: Verify the end-to-end worktree isolation contract**

Confirm these invariants by reading `src/orchestration/WorkerLoop.ts`:

1. When `worktreeIsolation: false` — `activeWorktreePath` is `undefined`, `effectiveRoot = this.projectRoot`, identical to pre-Phase-4 behaviour.
2. When `worktreeIsolation: true` and worktree creation succeeds — `activeWorktreePath` is the temp path, `effectiveRoot` = worktree path for all 6 sites.
3. When `worktreeIsolation: true` but worktree creation fails (caught) — `activeWorktreePath` is `undefined`, falls back to `this.projectRoot`.
4. After the tool-calling loop, `commitAndApply` copies worktree changes to the main tree, then `discard` cleans up the temp path.

- [ ] **Step 4: Commit (if any outstanding changes)**

```bash
git add -p
git commit -m "chore(orchestration): Phase 5 final audit"
```

---

## What Phase 5 delivers

| Invariant | Phase 4 | Phase 5 |
|-----------|---------|---------|
| Worktree created per task | ✅ | ✅ |
| LLM tool writes go to worktree | ❌ (still `projectRoot`) | ✅ (`effectiveRoot`) |
| Path-policy checked against worktree | ❌ | ✅ |
| Pre-edit snapshots in worktree | ❌ | ✅ |
| `commitAndApply` captures real changes | ❌ (worktree is empty) | ✅ |
| Fallback to `projectRoot` on create failure | ✅ | ✅ |
| TypeScript clean, no regressions | ✅ | ✅ |

**What remains after Phase 5:** Memory candidate staging (`writeCandidate(opts.projectRoot, candidate)` in `TaskRunner.ts`) still uses the original `projectRoot`. This is intentional — memory candidates are pipeline-level state, not task-level writes, and belong in the main tree regardless of isolation.
