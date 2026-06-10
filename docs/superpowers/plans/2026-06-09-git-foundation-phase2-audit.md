# Git Foundation — Phase 2: Audit Refs & Run History

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every agent run a durable, browsable git identity — snapshots become real commits under `refs/minimum/<runId>/task/<taskId>`, phase completions become checkpoint refs, and `/history` lets you browse all past runs from the TUI.

**Architecture:** `AgentGitStore.commitTree` gains a `trailers` option so any commit can carry structured metadata (Minimum-Run, Minimum-Task, etc.). `GitSnapshotManager` is upgraded from loose blob storage to real commits chained under `refs/minimum/<runId>/task/<taskId>`. A new `RunAuditStore` writes and reads checkpoint refs. `WorkerLoop` sets a `done` checkpoint after each task. The `/history` TUI command reads all of this and formats it as a system message.

**Tech Stack:** TypeScript (ESM), Node.js `child_process`, Vitest, existing `AgentGitStore` / `GitSnapshotManager` from Phase 1

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/git/AgentGitStore.ts` | Add `trailers` to `commitTree` opts, add `forEachRef`, add git identity env for commit-tree |
| Modify | `src/git/types.ts` | Add `CommitOpts` interface |
| Modify | `src/git/GitSnapshotManager.ts` | Upgrade from loose blobs to commits with refs + trailers |
| Create | `src/git/RunAuditStore.ts` | Checkpoint refs + run/checkpoint listing |
| Modify | `src/git/index.ts` | Export `RunAuditStore`, `CommitOpts` |
| Modify | `src/orchestration/WorkerLoop.ts` | Wire task-done checkpoint after runTask |
| Modify | `tui/src/commands.ts` | Add `history` to COMMANDS, CommandOutcome, runCommand |
| Modify | `tui/src/app.tsx` | Handle `history` outcome (async git → system.push) |
| Modify | `tests/unit/AgentGitStore.test.ts` | Update commitTree call site to new opts signature |
| Modify | `tests/unit/GitSnapshotManager.test.ts` | Tests still pass (same external behavior) |
| Create | `tests/unit/RunAuditStore.test.ts` | Integration tests for checkpoint + listing |

---

## Task 1: `commitTree` opts refactor + `forEachRef` + git identity

**Files:**
- Modify: `src/git/types.ts`
- Modify: `src/git/AgentGitStore.ts`
- Modify: `tests/unit/AgentGitStore.test.ts`

- [ ] **Step 1: Add `CommitOpts` to `src/git/types.ts`**

Open `src/git/types.ts` and add at the end:

```typescript
export interface CommitOpts {
  /** SHA of the parent commit. Omit for an initial (root) commit. */
  parent?: string;
  /**
   * Key-value pairs appended as git trailers after a blank line, e.g.
   *   `{ "Minimum-Run": "run_123", "Minimum-Task": "t-1" }`
   * becomes:
   *   `Minimum-Run: run_123\nMinimum-Task: t-1`
   */
  trailers?: Record<string, string>;
}
```

- [ ] **Step 2: Run existing tests to confirm they still pass (baseline)**

```
npx vitest run tests/unit/AgentGitStore.test.ts
```
Expected: 5 passed.

- [ ] **Step 3: Add trailers test to `tests/unit/AgentGitStore.test.ts`**

Append this new `describe` block to the existing file:

```typescript
describe("AgentGitStore.commitTree trailers + forEachRef", () => {
  it("embeds trailers in the commit message", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);

    const sha = await store.commitTree(
      [{ relativePath: "x.txt", content: "hi" }],
      "feat: test",
      { trailers: { "Minimum-Run": "run-1", "Minimum-Task": "task-1" } },
    );
    // Read the commit message back and confirm trailers are present
    const { execFileSync: syncExec } = await import("node:child_process");
    const msg: string = syncExec("git", ["log", "--format=%B", "-1", sha], { cwd: tmpDir }).toString();
    expect(msg).toContain("Minimum-Run: run-1");
    expect(msg).toContain("Minimum-Task: task-1");
  });

  it("forEachRef lists refs matching a pattern", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);

    const sha = await store.commitTree(
      [{ relativePath: "y.txt", content: "yo" }],
      "test",
      {},
    );
    await store.setRef("refs/minimum/run-42/checkpoint/done", sha);

    const refs = await store.forEachRef("refs/minimum/**/checkpoint/*");
    expect(refs).toHaveLength(1);
    expect(refs[0].ref).toBe("refs/minimum/run-42/checkpoint/done");
    expect(refs[0].sha).toBe(sha);
  });

  it("forEachRef returns empty array when no refs match", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);
    const result = await store.forEachRef("refs/minimum/*/checkpoint/*");
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 4: Run to verify new tests FAIL**

```
npx vitest run tests/unit/AgentGitStore.test.ts
```
Expected: 3 new tests fail (`store.forEachRef is not a function`).

- [ ] **Step 5: Update `AgentGitStore.commitTree` to accept `CommitOpts`**

In `src/git/AgentGitStore.ts`, replace the `commitTree` method signature and implementation:

```typescript
  async commitTree(
    files: import("./types.js").FileChange[],
    message: string,
    opts?: import("./types.js").CommitOpts,
  ): Promise<string> {
    const tmpIdx = path.join(
      os.tmpdir(),
      `minimum-idx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const idxEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tmpIdx };

      await this.git(["read-tree", "--empty"], { env: idxEnv });

      for (const f of files) {
        if (f.content === null) continue;
        const blobSha = await this.git(["hash-object", "-w", "--stdin"], {
          env: idxEnv,
          input: f.content,
        });
        await this.git(
          ["update-index", "--add", "--cacheinfo", `100644,${blobSha},${f.relativePath}`],
          { env: idxEnv },
        );
      }

      const treeSha = await this.git(["write-tree"], { env: idxEnv });

      // Build commit message with optional trailers.
      const trailerBlock = opts?.trailers
        ? "\n\n" +
          Object.entries(opts.trailers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n")
        : "";
      const fullMessage = message + trailerBlock;

      const commitArgs = ["commit-tree", treeSha, "-m", fullMessage];
      if (opts?.parent) commitArgs.push("-p", opts.parent);

      // Provide a minimal git identity so commit-tree works in bare/shadow repos
      // and CI environments that have no global git config.
      const identityEnv: NodeJS.ProcessEnv = {
        GIT_AUTHOR_NAME: "minimum-agent",
        GIT_AUTHOR_EMAIL: "agent@minimum.local",
        GIT_COMMITTER_NAME: "minimum-agent",
        GIT_COMMITTER_EMAIL: "agent@minimum.local",
      };
      const commitSha = await this.git(commitArgs, { env: identityEnv });
      return commitSha;
    } finally {
      await fs.unlink(tmpIdx).catch(() => {});
    }
  }
```

- [ ] **Step 6: Add `forEachRef` method to `AgentGitStore`**

Add this method after `readBlob` in `src/git/AgentGitStore.ts`:

```typescript
  /**
   * List refs matching a glob pattern (e.g. `"refs/minimum/**/checkpoint/*"`).
   * Returns an empty array if there are no matching refs or the store has no
   * refs at all (fresh repo).
   */
  async forEachRef(
    pattern: string,
  ): Promise<Array<{ ref: string; sha: string }>> {
    try {
      const output = await this.git([
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        pattern,
      ]);
      if (!output) return [];
      return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const spaceIdx = line.indexOf(" ");
          return {
            ref: line.slice(0, spaceIdx),
            sha: line.slice(spaceIdx + 1),
          };
        });
    } catch {
      return [];
    }
  }
```

- [ ] **Step 7: Run tests to verify all 8 pass**

```
npx vitest run tests/unit/AgentGitStore.test.ts
```
Expected: 8 passed (5 original + 3 new).

- [ ] **Step 8: Run typecheck**

```
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 9: Commit**

```bash
git add src/git/types.ts src/git/AgentGitStore.ts tests/unit/AgentGitStore.test.ts
git commit -m "feat(git): commitTree opts (trailers + identity), forEachRef primitive"
```

---

## Task 2: Upgrade `GitSnapshotManager` to real commits + refs

**Files:**
- Modify: `src/git/GitSnapshotManager.ts`
- Modify: `tests/unit/GitSnapshotManager.test.ts`

The upgrade replaces loose blob storage with real commits under
`refs/minimum/<runId>/task/<taskId>`. External behavior (snapshot/restore/reset
signatures and semantics) is unchanged — tests pass without modification.

- [ ] **Step 1: Run existing tests to confirm baseline**

```
npx vitest run tests/unit/GitSnapshotManager.test.ts
```
Expected: 3 passed.

- [ ] **Step 2: Rewrite `src/git/GitSnapshotManager.ts`**

Replace the entire file:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentGitStore } from "./AgentGitStore.js";
import type { RunId, TaskId } from "./types.js";

interface SnapEntry {
  /**
   * Commit SHA under refs/minimum/<runId>/task/<taskId>, or null when
   * the file did not exist before the snapshot was taken.
   */
  commitSha: string | null;
  /** Path relative to the store work-tree (forward slashes). */
  relativePath: string;
}

/**
 * Drop-in replacement for `SnapshotManager`.
 *
 * Each `snapshot()` call creates a real git commit under
 * `refs/minimum/<runId>/task/<taskId>` so snapshots survive process restarts
 * and can be browsed with `RunAuditStore`. The external interface
 * (snapshot / restore / reset) is identical to the old in-memory manager.
 */
export class GitSnapshotManager {
  private entries = new Map<string, SnapEntry>(); // key = absolute path

  constructor(
    private readonly store: AgentGitStore,
    private readonly runId: RunId,
    private readonly taskId: TaskId,
  ) {}

  private resolvePath(rawPath: string, workingDirectory?: string): string {
    return workingDirectory
      ? path.resolve(workingDirectory, rawPath)
      : path.resolve(rawPath);
  }

  private get taskRef(): string {
    return `refs/minimum/${this.runId}/task/${this.taskId}`;
  }

  /** Capture file state before an edit. No-op if already snapshotted. */
  async snapshot(rawPath: string, workingDirectory?: string): Promise<void> {
    const abs = this.resolvePath(rawPath, workingDirectory);
    if (this.entries.has(abs)) return;

    // Compute path relative to the work-tree (forward slashes for git).
    const relativePath = path
      .relative(this.store.config.workTree, abs)
      .replace(/\\/g, "/");

    let content: string | null;
    try {
      content = await fs.readFile(abs, "utf-8");
    } catch {
      content = null; // file did not exist
    }

    if (content === null) {
      this.entries.set(abs, { commitSha: null, relativePath });
      return;
    }

    // Chain commits: read current tip as parent so the ref grows linearly.
    const parent = (await this.store.readRef(this.taskRef)) ?? undefined;
    const commitSha = await this.store.commitTree(
      [{ relativePath, content }],
      `snapshot: ${relativePath}`,
      {
        parent,
        trailers: {
          "Minimum-Run": this.runId,
          "Minimum-Task": this.taskId,
        },
      },
    );
    await this.store.setRef(this.taskRef, commitSha);
    this.entries.set(abs, { commitSha, relativePath });
  }

  /** Restore a file to its snapshotted state. Returns false if not snapshotted. */
  async restore(rawPath: string, workingDirectory?: string): Promise<boolean> {
    const abs = this.resolvePath(rawPath, workingDirectory);
    const entry = this.entries.get(abs);
    if (entry === undefined) return false;

    if (entry.commitSha === null) {
      // File did not exist before — delete it.
      await fs.unlink(abs).catch(() => {});
    } else {
      const content = await this.store.readFileAtCommit(
        entry.commitSha,
        entry.relativePath,
      );
      if (content === null) return false;
      await fs.writeFile(abs, content, "utf-8");
    }
    return true;
  }

  /** Clear all snapshots (called when a task scope ends cleanly). */
  reset(): void {
    this.entries.clear();
  }
}
```

- [ ] **Step 3: Run tests — must still pass with no changes**

```
npx vitest run tests/unit/GitSnapshotManager.test.ts
```
Expected: 3 passed (same behavior, different implementation).

- [ ] **Step 4: Run typecheck**

```
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 5: Verify the ref is actually written by adding an assertion to the idempotency test**

In `tests/unit/GitSnapshotManager.test.ts`, extend the `"is idempotent"` test. After the final `await mgr.restore(...)` line, add:

```typescript
// Verify a task ref was written to the git store.
const { execFileSync: syncExec } = await import("node:child_process");
const refs: string = syncExec(
  "git",
  ["for-each-ref", "--format=%(refname)", "refs/minimum/run-1/"],
  { cwd: tmpDir },
).toString().trim();
expect(refs).toContain("refs/minimum/run-1/task/task-3");
```

- [ ] **Step 6: Run tests again**

```
npx vitest run tests/unit/GitSnapshotManager.test.ts
```
Expected: 3 passed (including the new assertion).

- [ ] **Step 7: Commit**

```bash
git add src/git/GitSnapshotManager.ts tests/unit/GitSnapshotManager.test.ts
git commit -m "feat(git): GitSnapshotManager — real commits with trailers under task refs"
```

---

## Task 3: `RunAuditStore` — checkpoints + listing

**Files:**
- Create: `src/git/RunAuditStore.ts`
- Modify: `src/git/index.ts`
- Create: `tests/unit/RunAuditStore.test.ts`

- [ ] **Step 1: Write failing tests in `tests/unit/RunAuditStore.test.ts`**

```typescript
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGitStore } from "../../src/git/AgentGitStore.js";
import { RunAuditStore } from "../../src/git/RunAuditStore.js";

let tmpDir: string;
let store: AgentGitStore;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-audit-"));
  execFileSync("git", ["init"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
  store = await AgentGitStore.resolve(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const slug = tmpDir.replace(/[/\\:]/g, "-").replace(/^-+/, "");
  const shadowBase = path.join(os.homedir(), ".minimum", "shadow", slug);
  fs.rmSync(shadowBase, { recursive: true, force: true });
});

describe("RunAuditStore.setCheckpoint", () => {
  it("creates a ref at the expected path and returns a sha", async () => {
    const audit = new RunAuditStore(store);
    const sha = await audit.setCheckpoint("run-1", "done");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const read = await store.readRef("refs/minimum/run-1/checkpoint/done");
    expect(read).toBe(sha);
  });

  it("idempotent: calling twice updates the ref", async () => {
    const audit = new RunAuditStore(store);
    const sha1 = await audit.setCheckpoint("run-1", "w1-complete");
    const sha2 = await audit.setCheckpoint("run-1", "w1-complete");
    expect(sha1).not.toBe(sha2); // new commit each time
    const ref = await store.readRef("refs/minimum/run-1/checkpoint/w1-complete");
    expect(ref).toBe(sha2); // ref points to latest
  });
});

describe("RunAuditStore.listRuns + listCheckpoints + listTaskRefs", () => {
  it("listRuns returns deduplicated runIds from checkpoint refs", async () => {
    const audit = new RunAuditStore(store);
    await audit.setCheckpoint("run-a", "done");
    await audit.setCheckpoint("run-a", "w1-complete");
    await audit.setCheckpoint("run-b", "done");

    const runs = await audit.listRuns();
    expect(runs.sort()).toEqual(["run-a", "run-b"]);
  });

  it("listRuns returns empty array when no checkpoints exist", async () => {
    const audit = new RunAuditStore(store);
    expect(await audit.listRuns()).toEqual([]);
  });

  it("listCheckpoints returns checkpoints for a specific run", async () => {
    const audit = new RunAuditStore(store);
    await audit.setCheckpoint("run-x", "done");
    await audit.setCheckpoint("run-x", "w3-complete");
    await audit.setCheckpoint("run-y", "done"); // different run, must not appear

    const cps = await audit.listCheckpoints("run-x");
    const phases = cps.map((c) => c.phase).sort();
    expect(phases).toEqual(["done", "w3-complete"]);
  });

  it("listTaskRefs returns task refs for a run", async () => {
    const audit = new RunAuditStore(store);
    // Manually write a task ref (normally done by GitSnapshotManager).
    const sha = await store.commitTree(
      [{ relativePath: "a.ts", content: "x" }],
      "snap",
      {},
    );
    await store.setRef("refs/minimum/run-z/task/task-1", sha);

    const tasks = await audit.listTaskRefs("run-z");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe("task-1");
    expect(tasks[0].sha).toBe(sha);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

```
npx vitest run tests/unit/RunAuditStore.test.ts
```
Expected: `Cannot find module '../../src/git/RunAuditStore.js'`

- [ ] **Step 3: Write `src/git/RunAuditStore.ts`**

```typescript
import type { AgentGitStore } from "./AgentGitStore.js";
import type { RunId } from "./types.js";

export interface CheckpointEntry {
  phase: string;
  sha: string;
}

export interface TaskRefEntry {
  taskId: string;
  sha: string;
}

/**
 * Manages checkpoint refs and provides browsing for agent run history.
 *
 * Checkpoints live at `refs/minimum/<runId>/checkpoint/<phase>`.
 * Task snapshots live at `refs/minimum/<runId>/task/<taskId>`.
 * Both are written into the same `AgentGitStore` (user repo or shadow repo).
 */
export class RunAuditStore {
  constructor(private readonly store: AgentGitStore) {}

  /**
   * Record a phase completion by creating an empty-tree commit with metadata
   * trailers and pointing `refs/minimum/<runId>/checkpoint/<phase>` at it.
   * Returns the new commit sha.
   */
  async setCheckpoint(runId: RunId, phase: string): Promise<string> {
    const ref = `refs/minimum/${runId}/checkpoint/${phase}`;
    const existing = (await this.store.readRef(ref)) ?? undefined;
    const sha = await this.store.commitTree([], `checkpoint: ${phase}`, {
      parent: existing,
      trailers: {
        "Minimum-Run": runId,
        "Minimum-Phase": phase,
      },
    });
    await this.store.setRef(ref, sha);
    return sha;
  }

  /** Return all distinct run IDs that have at least one checkpoint ref. */
  async listRuns(): Promise<RunId[]> {
    const refs = await this.store.forEachRef(
      "refs/minimum/*/checkpoint/*",
    );
    const ids = new Set<string>();
    for (const { ref } of refs) {
      // ref format: refs/minimum/<runId>/checkpoint/<phase>
      const m = ref.match(/^refs\/minimum\/([^/]+)\/checkpoint\//);
      if (m?.[1]) ids.add(m[1]);
    }
    return [...ids].sort();
  }

  /** Return all checkpoint entries for a given run, sorted by phase name. */
  async listCheckpoints(runId: RunId): Promise<CheckpointEntry[]> {
    const prefix = `refs/minimum/${runId}/checkpoint/`;
    const refs = await this.store.forEachRef(`${prefix}*`);
    return refs
      .map(({ ref, sha }) => ({ phase: ref.slice(prefix.length), sha }))
      .sort((a, b) => a.phase.localeCompare(b.phase));
  }

  /** Return all task snapshot refs for a given run. */
  async listTaskRefs(runId: RunId): Promise<TaskRefEntry[]> {
    const prefix = `refs/minimum/${runId}/task/`;
    const refs = await this.store.forEachRef(`${prefix}*`);
    return refs.map(({ ref, sha }) => ({
      taskId: ref.slice(prefix.length),
      sha,
    }));
  }
}
```

- [ ] **Step 4: Export from `src/git/index.ts`**

Add to `src/git/index.ts`:

```typescript
export { RunAuditStore } from "./RunAuditStore.js";
export type { CheckpointEntry, TaskRefEntry } from "./RunAuditStore.js";
export type { CommitOpts } from "./types.js";
```

- [ ] **Step 5: Run tests to verify all pass**

```
npx vitest run tests/unit/RunAuditStore.test.ts
```
Expected: 6 tests pass.

- [ ] **Step 6: Run full unit suite for regressions**

```
npx vitest run tests/unit/
```
Expected: all existing tests still pass.

- [ ] **Step 7: Typecheck**

```
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add src/git/RunAuditStore.ts src/git/index.ts src/git/types.ts tests/unit/RunAuditStore.test.ts
git commit -m "feat(git): RunAuditStore — checkpoint refs and run history listing"
```

---

## Task 4: Wire task-done checkpoint into `WorkerLoop`

**Files:**
- Modify: `src/orchestration/WorkerLoop.ts`

The `WorkerLoop.runTask()` method already creates a `GitSnapshotManager` (from Phase 1). After the task executor completes, we set a `task/<taskId>/done` checkpoint so `RunAuditStore.listRuns()` has data to return.

- [ ] **Step 1: Read the relevant section of `WorkerLoop.ts`**

Find the `runTask` method (around line 199). Locate:
1. Where `gitStore` and `runId` variables are declared (from Phase 1 wiring)
2. Where the executor returns its result (`const result = await ...`)
3. A suitable place after the result is obtained to set the checkpoint

- [ ] **Step 2: Add `RunAuditStore` import**

In `src/orchestration/WorkerLoop.ts`, add to the imports from `../git/index.js`:

Find:
```typescript
import { AgentGitStore, GitSnapshotManager } from "../git/index.js";
```
Replace with:
```typescript
import { AgentGitStore, GitSnapshotManager, RunAuditStore } from "../git/index.js";
```

- [ ] **Step 3: Set checkpoint after task result**

In the `runTask` method, after the `gitStore` and `runId` are available and after the executor call returns a result, add a fire-and-forget checkpoint (don't await — don't block the task result on audit):

```typescript
// Fire-and-forget: record a task-done checkpoint for run history.
void new RunAuditStore(gitStore)
  .setCheckpoint(runId, `task/${input.contract.taskId}/done`)
  .catch(() => {}); // audit failure must never affect task outcome
```

Place this immediately after the line that assigns the task result (before the `return result`), but **outside** any try/catch that would suppress the fire-and-forget.

- [ ] **Step 4: Typecheck**

```
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 5: Run unit tests**

```
npx vitest run tests/unit/
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/WorkerLoop.ts
git commit -m "feat(git): wire task-done checkpoint into WorkerLoop"
```

---

## Task 5: `/history` TUI command

**Files:**
- Modify: `tui/src/commands.ts`
- Modify: `tui/src/app.tsx`

- [ ] **Step 1: Read how existing async outcomes are handled**

Read `tui/src/app.tsx` around lines 540–600 to understand the `plan.drafts` / `plan.preview` pattern (async git call → `system.push` dispatch). The `history` outcome follows the same pattern.

- [ ] **Step 2: Add `history` to `CommandOutcome` in `tui/src/commands.ts`**

Find the `CommandOutcome` type definition (around line 228). Add after the last existing union member:
```typescript
  | { kind: 'history'; runId?: string }
```

- [ ] **Step 3: Add `history` to `COMMANDS` in `tui/src/commands.ts`**

In the `COMMANDS` array, add under the `// view` section:
```typescript
  { name: 'history', desc: 'Browse agent run history', category: 'view', usage: '/history [runId]' },
```

- [ ] **Step 4: Add `case 'history'` to `runCommand` in `tui/src/commands.ts`**

Inside the `switch (cmd.name)` block in `runCommand`, add:
```typescript
    case 'history':
      return { kind: 'history', runId: args[0] };
```

- [ ] **Step 5: Handle `history` outcome in `tui/src/app.tsx`**

First, add the import at the top of `tui/src/app.tsx` (near where other `src/` imports are):
```typescript
import { AgentGitStore, RunAuditStore } from '../../src/git/index.js';
```

Then, inside the outcomes handler switch (where `case 'plan.drafts':` and `case 'plan.preview':` live), add:
```typescript
      case 'history': {
        const projectRoot = stateRef.current.path;
        void (async () => {
          try {
            const store = await AgentGitStore.resolve(projectRoot);
            const audit = new RunAuditStore(store);

            if (o.runId) {
              // Single-run view.
              const [checkpoints, tasks] = await Promise.all([
                audit.listCheckpoints(o.runId),
                audit.listTaskRefs(o.runId),
              ]);
              if (checkpoints.length === 0 && tasks.length === 0) {
                dispatch({ type: 'system.push', text: `Run "${o.runId}" not found.`, tone: 'warn' });
                return;
              }
              const lines: string[] = [`Run: ${o.runId}`, ''];
              if (checkpoints.length > 0) {
                lines.push('Checkpoints:');
                for (const { phase, sha } of checkpoints) {
                  lines.push(`  ✓ ${phase.padEnd(28)}  ${sha.slice(0, 8)}`);
                }
              }
              if (tasks.length > 0) {
                lines.push('');
                lines.push('Tasks:');
                for (const { taskId, sha } of tasks) {
                  lines.push(`  · ${taskId.padEnd(28)}  ${sha.slice(0, 8)}`);
                }
              }
              dispatch({ type: 'system.push', text: lines.join('\n'), tone: 'info' });
            } else {
              // All-runs listing.
              const runs = await audit.listRuns();
              if (runs.length === 0) {
                dispatch({ type: 'system.push', text: 'No runs recorded yet. Runs are created automatically when tasks complete.', tone: 'info' });
                return;
              }
              const lines: string[] = [`${runs.length} run(s) recorded:`, ''];
              for (const runId of runs) {
                const cps = await audit.listCheckpoints(runId);
                lines.push(`  ${runId}  (${cps.length} checkpoint(s))`);
              }
              dispatch({ type: 'system.push', text: lines.join('\n'), tone: 'info' });
            }
          } catch (err) {
            dispatch({ type: 'system.push', text: `history: ${String((err as Error)?.message ?? err)}`, tone: 'warn' });
          }
        })();
        return;
      }
```

- [ ] **Step 6: Typecheck**

```
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 7: Run unit tests**

```
npx vitest run tests/unit/
```
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add tui/src/commands.ts tui/src/app.tsx
git commit -m "feat(tui): /history command — browse agent run history"
```

---

## What's Not In This Plan (future phases)

| Phase | What | Plan file |
|-------|------|-----------|
| Phase 3 | Sub-project D — Session state in git (replace CheckpointManager JSON) | `2026-06-09-git-foundation-phase3-session.md` |
| Phase 4 | Sub-project B — Worktree isolation for parallel workers | `2026-06-09-git-foundation-phase4-worktree.md` |
