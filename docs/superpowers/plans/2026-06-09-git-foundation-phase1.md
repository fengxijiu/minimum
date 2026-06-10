# Git Foundation — Phase 1: AgentGitStore + Git-Backed Rollback

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-memory `SnapshotManager` with a git-backed equivalent that stores file snapshots as real git objects under `refs/minimum/*`, surviving process crashes and enabling point-in-time rollback.

**Architecture:** A static factory `AgentGitStore.resolve(projectRoot)` detects whether the project is inside a git repo; if not, it initialises a shadow repo at `~/.minimum/shadow/<slug>/.git` with the project root as the work-tree. All snapshot/restore operations use an isolated `GIT_INDEX_FILE` so the user's staging area is never touched. `GitSnapshotManager` wraps `AgentGitStore` with the same `snapshot(path, cwd?) / restore(path, cwd?) / reset()` interface as the existing `SnapshotManager`, making the swap in `MiMoLoop` and `WorkerLoop` minimal.

**Tech Stack:** TypeScript (ESM), Node.js `child_process.execFile`, Vitest

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/git/types.ts` | Shared types: `RunId`, `TaskId`, `FileChange`, `StoreConfig` |
| Create | `src/git/AgentGitStore.ts` | Low-level git primitives: `resolve`, `commitTree`, `setRef`, `readRef` |
| Create | `src/git/GitSnapshotManager.ts` | Drop-in replacement for `SnapshotManager`; uses `AgentGitStore` |
| Create | `src/git/index.ts` | Re-exports |
| Create | `tests/unit/AgentGitStore.test.ts` | Integration tests (real temp git repos) |
| Create | `tests/unit/GitSnapshotManager.test.ts` | Integration tests |
| Modify | `src/loop/MiMoLoop.ts:291` | Swap `new SnapshotManager()` → `new GitSnapshotManager(store)` |
| Modify | `src/orchestration/WorkerLoop.ts:225-229` | Same swap, per-task |

---

## Task 1: Types

**Files:**
- Create: `src/git/types.ts`
- Create: `src/git/index.ts`

- [ ] **Step 1: Write `src/git/types.ts`**

```typescript
export type RunId  = string; // `run_${timestamp}_${random}`
export type TaskId = string;

export interface FileChange {
  /** Relative path from the work-tree root (forward slashes). */
  relativePath: string;
  /** File content as utf-8 string, or `null` if the file was deleted. */
  content: string | null;
}

export interface StoreConfig {
  /** Absolute path to the `.git` directory (may be a shadow repo). */
  gitDir: string;
  /** Absolute path to the project root used as the work-tree. */
  workTree: string;
}
```

- [ ] **Step 2: Write `src/git/index.ts`**

```typescript
export { AgentGitStore } from "./AgentGitStore.js";
export { GitSnapshotManager } from "./GitSnapshotManager.js";
export type { FileChange, RunId, StoreConfig, TaskId } from "./types.js";
```

- [ ] **Step 3: Commit**

```bash
git add src/git/types.ts src/git/index.ts
git commit -m "feat(git): add AgentGitStore types and barrel export"
```

---

## Task 2: AgentGitStore — resolve + helpers

**Files:**
- Create: `src/git/AgentGitStore.ts`
- Create: `tests/unit/AgentGitStore.test.ts` (partial — resolve tests only)

- [ ] **Step 1: Write the failing test for `resolve` in `tests/unit/AgentGitStore.test.ts`**

```typescript
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGitStore } from "../../src/git/AgentGitStore.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("AgentGitStore.resolve", () => {
  it("uses the user .git when inside a git repo", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);
    expect(store.config.gitDir).toBe(path.join(tmpDir, ".git"));
    expect(store.config.workTree).toBe(tmpDir);
  });

  it("creates a shadow repo when not inside a git repo", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    expect(store.config.gitDir).toContain(".minimum");
    expect(store.config.gitDir).toContain("shadow");
    expect(fs.existsSync(store.config.gitDir)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

```
npx vitest run tests/unit/AgentGitStore.test.ts
```
Expected: `Cannot find module '../../src/git/AgentGitStore.js'`

- [ ] **Step 3: Write `src/git/AgentGitStore.ts` — skeleton + `resolve`**

```typescript
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { StoreConfig } from "./types.js";

const execFileAsync = promisify(execFile);

/** Replaces `:`, `\`, `/` with `-` and strips leading dashes. */
function slugifyPath(p: string): string {
  return p.replace(/[:\\/]/g, "-").replace(/^-+/, "");
}

export class AgentGitStore {
  readonly config: StoreConfig;

  constructor(config: StoreConfig) {
    this.config = config;
  }

  /**
   * Resolve or create the git store for `projectRoot`.
   * - If `projectRoot` is inside a git repo, reuses its `.git`.
   * - Otherwise, creates a shadow bare-ish repo at
   *   `~/.minimum/shadow/<slug>/.git` with `projectRoot` as work-tree.
   */
  static async resolve(projectRoot: string): Promise<AgentGitStore> {
    const abs = path.resolve(projectRoot);
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--git-dir"], {
        cwd: abs,
      });
      const rel = stdout.trim();
      const gitDir = path.isAbsolute(rel) ? rel : path.resolve(abs, rel);
      return new AgentGitStore({ gitDir, workTree: abs });
    } catch {
      // Not inside a git repo — create shadow.
      const slug = slugifyPath(abs);
      const shadowBase = path.join(os.homedir(), ".minimum", "shadow", slug);
      const gitDir = path.join(shadowBase, ".git");
      await fs.mkdir(shadowBase, { recursive: true });
      try {
        await execFileAsync("git", ["init", "--separate-git-dir", gitDir, abs], {
          cwd: abs,
        });
      } catch {
        // Already initialised — ignore.
      }
      return new AgentGitStore({ gitDir, workTree: abs });
    }
  }

  /** Run a git command with `GIT_DIR` and `GIT_WORK_TREE` set. */
  private async git(
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; input?: string },
  ): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: this.config.gitDir,
      GIT_WORK_TREE: this.config.workTree,
      ...(opts?.env ?? {}),
    };
    const { stdout } = await execFileAsync("git", args, {
      env,
      cwd: this.config.workTree,
      maxBuffer: 64 * 1024 * 1024,
      ...(opts?.input !== undefined
        ? { input: opts.input }
        : {}),
    });
    return stdout.trim();
  }
}
```

- [ ] **Step 4: Run tests to verify PASS**

```
npx vitest run tests/unit/AgentGitStore.test.ts
```
Expected: 2 passing tests in the `resolve` suite.

- [ ] **Step 5: Commit**

```bash
git add src/git/AgentGitStore.ts tests/unit/AgentGitStore.test.ts
git commit -m "feat(git): AgentGitStore.resolve — detect or create git store"
```

---

## Task 3: AgentGitStore — commitTree, setRef, readRef

**Files:**
- Modify: `src/git/AgentGitStore.ts` (add three methods)
- Modify: `tests/unit/AgentGitStore.test.ts` (add suites)

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/AgentGitStore.test.ts`:

```typescript
describe("AgentGitStore.commitTree + setRef + readRef", () => {
  it("stores a file as a commit and recalls it via ref", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    // git needs at least a user identity to commit-tree
    execFileSync("git", ["config", "user.email", "test@minimum"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "minimum-test"], { cwd: tmpDir });

    const store = await AgentGitStore.resolve(tmpDir);

    const sha = await store.commitTree(
      [{ relativePath: "hello.txt", content: "world" }],
      "test commit",
    );
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const ref = "refs/minimum/run-test/task-1";
    await store.setRef(ref, sha);
    const read = await store.readRef(ref);
    expect(read).toBe(sha);
  });

  it("returns null for a missing ref", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);
    expect(await store.readRef("refs/minimum/does-not-exist")).toBeNull();
  });

  it("records a null-content file as a deletion marker", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);
    // Should not throw when content is null (file did not exist)
    const sha = await store.commitTree(
      [{ relativePath: "gone.txt", content: null }],
      "deletion snapshot",
    );
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

```
npx vitest run tests/unit/AgentGitStore.test.ts
```
Expected: `store.commitTree is not a function`

- [ ] **Step 3: Implement `commitTree`, `setRef`, `readRef`**

Add the following methods to the `AgentGitStore` class in `src/git/AgentGitStore.ts`, before the closing `}`:

```typescript
  /**
   * Commit a set of file changes to the git object store using an isolated
   * index (GIT_INDEX_FILE points to a temp file — user's staging area is
   * never touched).  Returns the commit sha.
   *
   * `parent` is the sha of the parent commit (omit for an initial commit).
   */
  async commitTree(
    files: import("./types.js").FileChange[],
    message: string,
    parent?: string,
  ): Promise<string> {
    const tmpIdx = path.join(
      os.tmpdir(),
      `minimum-idx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const idxEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tmpIdx };

      // Start with an empty index.
      await this.git(["read-tree", "--empty"], { env: idxEnv });

      // Hash each file into the object store and stage it.
      for (const f of files) {
        if (f.content === null) continue; // deleted — not added to tree
        const blobSha = await this.git(["hash-object", "-w", "--stdin"], {
          env: idxEnv,
          input: f.content,
        });
        await this.git(
          [
            "update-index",
            "--add",
            "--cacheinfo",
            `100644,${blobSha},${f.relativePath}`,
          ],
          { env: idxEnv },
        );
      }

      const treeSha = await this.git(["write-tree"], { env: idxEnv });

      const commitArgs = ["commit-tree", treeSha, "-m", message];
      if (parent) commitArgs.push("-p", parent);

      const commitSha = await this.git(commitArgs);
      return commitSha;
    } finally {
      await fs.unlink(tmpIdx).catch(() => {});
    }
  }

  /** Write `refs/minimum/…` to point at `sha`. */
  async setRef(ref: string, sha: string): Promise<void> {
    await this.git(["update-ref", ref, sha]);
  }

  /** Read a ref; returns `null` if it does not exist. */
  async readRef(ref: string): Promise<string | null> {
    try {
      return await this.git(["rev-parse", ref]);
    } catch {
      return null;
    }
  }

  /**
   * Retrieve the content of a specific file from a commit sha.
   * Returns `null` if the path did not exist in that commit.
   */
  async readFileAtCommit(
    commitSha: string,
    relativePath: string,
  ): Promise<string | null> {
    try {
      return await this.git(["show", `${commitSha}:${relativePath}`]);
    } catch {
      return null;
    }
  }
```

- [ ] **Step 4: Run tests to verify PASS**

```
npx vitest run tests/unit/AgentGitStore.test.ts
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/git/AgentGitStore.ts tests/unit/AgentGitStore.test.ts
git commit -m "feat(git): AgentGitStore commitTree / setRef / readRef"
```

---

## Task 4: GitSnapshotManager — snapshot

**Files:**
- Create: `src/git/GitSnapshotManager.ts`
- Create: `tests/unit/GitSnapshotManager.test.ts`

- [ ] **Step 1: Write failing tests for `snapshot` in `tests/unit/GitSnapshotManager.test.ts`**

```typescript
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGitStore } from "../../src/git/AgentGitStore.js";
import { GitSnapshotManager } from "../../src/git/GitSnapshotManager.js";

let tmpDir: string;
let store: AgentGitStore;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-snap-"));
  execFileSync("git", ["init"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
  store = await AgentGitStore.resolve(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GitSnapshotManager.snapshot", () => {
  it("records existing file content before edit", async () => {
    const file = path.join(tmpDir, "a.ts");
    fs.writeFileSync(file, "original");

    const mgr = new GitSnapshotManager(store, "run-1", "task-1");
    await mgr.snapshot(file, tmpDir);

    // Overwrite the file — simulating an agent edit.
    fs.writeFileSync(file, "mutated");

    // Restore should bring back the original.
    const ok = await mgr.restore(file, tmpDir);
    expect(ok).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("original");
  });

  it("handles snapshot of a non-existent file (restore deletes it)", async () => {
    const file = path.join(tmpDir, "new.ts");
    const mgr = new GitSnapshotManager(store, "run-1", "task-2");
    // File does not exist yet.
    await mgr.snapshot(file, tmpDir);

    // Agent creates the file.
    fs.writeFileSync(file, "created by agent");

    const ok = await mgr.restore(file, tmpDir);
    expect(ok).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("is idempotent: snapshotting twice does not overwrite first snapshot", async () => {
    const file = path.join(tmpDir, "b.ts");
    fs.writeFileSync(file, "v1");

    const mgr = new GitSnapshotManager(store, "run-1", "task-3");
    await mgr.snapshot(file, tmpDir);

    fs.writeFileSync(file, "v2");
    await mgr.snapshot(file, tmpDir); // second call — should be no-op

    fs.writeFileSync(file, "v3");
    await mgr.restore(file, tmpDir);

    // Must restore to v1, not v2.
    expect(fs.readFileSync(file, "utf-8")).toBe("v1");
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

```
npx vitest run tests/unit/GitSnapshotManager.test.ts
```
Expected: `Cannot find module '../../src/git/GitSnapshotManager.js'`

- [ ] **Step 3: Write `src/git/GitSnapshotManager.ts`**

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentGitStore } from "./AgentGitStore.js";
import type { RunId, TaskId } from "./types.js";

interface SnapEntry {
  /** Blob sha in the git object store, or null when the file didn't exist. */
  blobSha: string | null;
}

/**
 * Drop-in replacement for `SnapshotManager`.
 *
 * Persists pre-edit file content as git blobs so rollbacks survive process
 * restarts.  The external interface (`snapshot` / `restore` / `reset`) is
 * identical to the old in-memory manager so call-sites need no changes.
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

  /** Capture file state before an edit.  No-op if already snapshotted. */
  async snapshot(rawPath: string, workingDirectory?: string): Promise<void> {
    const abs = this.resolvePath(rawPath, workingDirectory);
    if (this.entries.has(abs)) return;

    let content: string | null;
    try {
      content = await fs.readFile(abs, "utf-8");
    } catch {
      content = null; // file did not exist
    }

    if (content === null) {
      this.entries.set(abs, { blobSha: null });
      return;
    }

    // Store blob in git object store.
    const blobSha = await this.store.git_hashObject(content);
    this.entries.set(abs, { blobSha });
  }

  /** Restore a file to its snapshotted state.  Returns false if not snapshotted. */
  async restore(rawPath: string, workingDirectory?: string): Promise<boolean> {
    const abs = this.resolvePath(rawPath, workingDirectory);
    const entry = this.entries.get(abs);
    if (entry === undefined) return false;

    if (entry.blobSha === null) {
      // File did not exist before — delete it.
      await fs.unlink(abs).catch(() => {});
    } else {
      const content = await this.store.git_catBlob(entry.blobSha);
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

Note: `git_hashObject` and `git_catBlob` are two small helpers we'll add to `AgentGitStore` in the next step.

- [ ] **Step 4: Add `git_hashObject` and `git_catBlob` to `AgentGitStore`**

Add these two methods inside the `AgentGitStore` class in `src/git/AgentGitStore.ts`:

```typescript
  /** Store a blob in the object store; returns its sha. */
  async git_hashObject(content: string): Promise<string> {
    return this.git(["hash-object", "-w", "--stdin"], { input: content });
  }

  /** Retrieve blob content by sha; returns null if not found. */
  async git_catBlob(sha: string): Promise<string | null> {
    try {
      return await this.git(["cat-file", "blob", sha]);
    } catch {
      return null;
    }
  }
```

- [ ] **Step 5: Run tests to verify PASS**

```
npx vitest run tests/unit/GitSnapshotManager.test.ts
```
Expected: all 3 tests pass.

- [ ] **Step 6: Run full suite to verify no regressions**

```
npx vitest run tests/unit/
```
Expected: all existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/git/GitSnapshotManager.ts src/git/AgentGitStore.ts tests/unit/GitSnapshotManager.test.ts
git commit -m "feat(git): GitSnapshotManager — git-backed snapshot/restore"
```

---

## Task 5: Wire GitSnapshotManager into MiMoLoop

**Files:**
- Modify: `src/loop/MiMoLoop.ts`

First, read the current snapshot usage to know the exact lines:

- [ ] **Step 1: Read the relevant section of `MiMoLoop.ts`**

```
# Lines around 245, 291, 617, 664 in src/loop/MiMoLoop.ts
```

- [ ] **Step 2: Update imports in `MiMoLoop.ts`**

Find the line:
```typescript
import { SnapshotManager } from "./SnapshotManager.js";
```
Replace with:
```typescript
import { AgentGitStore, GitSnapshotManager } from "../git/index.js";
```

- [ ] **Step 3: Update the field declaration (around line 245)**

Find:
```typescript
private snapshotManager: SnapshotManager;
```
Replace with:
```typescript
private snapshotManager!: GitSnapshotManager;
```

- [ ] **Step 4: Update the constructor / initialization (around line 291)**

Find:
```typescript
this.snapshotManager = new SnapshotManager();
```
Replace with (async init deferred to first `run()` call):
```typescript
// Initialized lazily in run() once projectRoot is known.
```

- [ ] **Step 5: Add lazy init at the top of the `run()` generator**

In `MiMoLoop.run()`, add the initialization block before the first `yield`. Find the start of the `run` method body and add:

```typescript
if (!this.snapshotManager) {
  const store = await AgentGitStore.resolve(this.projectRoot);
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  this.snapshotManager = new GitSnapshotManager(store, runId, "loop");
}
```

- [ ] **Step 6: Type-check**

```
npx tsc --noEmit
```
Expected: no errors related to the changes above. Fix any type errors before proceeding.

- [ ] **Step 7: Run unit tests**

```
npx vitest run tests/unit/
```
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/loop/MiMoLoop.ts
git commit -m "feat(git): wire GitSnapshotManager into MiMoLoop"
```

---

## Task 6: Wire GitSnapshotManager into WorkerLoop

**Files:**
- Modify: `src/orchestration/WorkerLoop.ts`

- [ ] **Step 1: Read the relevant section of `WorkerLoop.ts`**

```
# Lines 225–235 in src/orchestration/WorkerLoop.ts (SnapshotManager instantiation)
```

- [ ] **Step 2: Update imports in `WorkerLoop.ts`**

Find:
```typescript
import { SnapshotManager } from "../loop/SnapshotManager.js";
```
Replace with:
```typescript
import { AgentGitStore, GitSnapshotManager } from "../git/index.js";
```

- [ ] **Step 3: Update the `runTask` method (around line 225)**

Find:
```typescript
const snapshots = new SnapshotManager();
```
Replace with:
```typescript
const _gitStore = await AgentGitStore.resolve(this.projectRoot);
const _runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
const snapshots = new GitSnapshotManager(_gitStore, _runId, contract.taskId);
```

(The variable names with `_` prefix exist only to satisfy linter; feel free to rename if the project convention differs.)

- [ ] **Step 4: Verify all `snapshots.snapshot(...)` and `snapshots.restore(...)` call signatures match**

The new `GitSnapshotManager` has the identical `(rawPath: string, workingDirectory?: string)` signature, so no call-site changes are needed. Confirm with:

```
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Run unit tests**

```
npx vitest run tests/unit/
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/WorkerLoop.ts
git commit -m "feat(git): wire GitSnapshotManager into WorkerLoop"
```

---

## Task 7: Final cleanup — remove old SnapshotManager import guard

**Files:**
- Check: `src/loop/SnapshotManager.ts` — do NOT delete yet (other code may import it)

- [ ] **Step 1: Grep for remaining imports**

```
grep -r "SnapshotManager" src/ --include="*.ts" -l
```
Expected: only `src/loop/SnapshotManager.ts` itself remains. If any other file still imports it, update that file to use `GitSnapshotManager`.

- [ ] **Step 2: Type-check the full project**

```
npx tsc --noEmit
```
Expected: zero errors.

- [ ] **Step 3: Run full test suite**

```
npx vitest run
```
Expected: all pass.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(git): Phase 1 complete — git-backed snapshot replaces SnapshotManager"
```

---

## What's Not In This Plan (future phases)

| Phase | What | Plan file |
|-------|------|-----------|
| Phase 2 | Sub-project C — Audit refs (annotate commits, `refs/minimum/<run>/checkpoint/*`) | `2026-06-09-git-foundation-phase2-audit.md` |
| Phase 3 | Sub-project D — Session state in git (replace CheckpointManager JSON) | `2026-06-09-git-foundation-phase3-session.md` |
| Phase 4 | Sub-project B — Worktree isolation for parallel workers | `2026-06-09-git-foundation-phase4-worktree.md` |
