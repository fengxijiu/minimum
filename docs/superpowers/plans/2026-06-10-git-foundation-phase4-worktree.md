# Git Foundation — Phase 4: Worktree Isolation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add git worktree primitives to `AgentGitStore`, introduce a `WorktreeIsolator` lifecycle class, wire it into `WorkerLoop` as an opt-in, and let `ResourceManager` skip `WriteLockManager` when worktree isolation is active — replacing conservative glob-locking with git's own object-store-backed isolation.

**Architecture:** Each task runs inside a `git worktree add --detach` working tree at a temp path. The LLM's tool-host writes files there instead of the main working tree. After task completion, `WorktreeIsolator.commitAndApply()` stages all worktree changes into a commit (via `git -C <path> commit`), diffs against the base SHA to find changed files, copies those files back to the main working tree, and prunes the worktree. `ResourceManager` skips `WriteLockManager.tryLock()` when `worktreeIsolation: true` is set — concurrent write access is now safe because each task owns its own filesystem tree. All new primitives live inside `AgentGitStore`; the `WorktreeIsolator` is a thin lifecycle coordinator on top.

**Tech Stack:** TypeScript (ESM), Node.js `child_process` (`execFileAsync`), `fs/promises`, Vitest, existing `AgentGitStore`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/git/AgentGitStore.ts` | Add `addWorktree`, `removeWorktree`, `captureWorktreeChanges`, `listChangedFiles`, `applyCommitFiles` |
| Modify | `tests/unit/AgentGitStore.test.ts` | Add 8 tests for the 5 new primitives |
| Create | `src/git/WorktreeIsolator.ts` | Lifecycle manager: `create / commitAndApply / discard` |
| Modify | `src/git/index.ts` | Export `WorktreeIsolator`, `WorktreeResult` |
| Create | `tests/unit/WorktreeIsolator.test.ts` | 6 integration tests |
| Modify | `src/orchestration/WorkerLoop.ts` | Add `worktreeIsolation?: boolean` to `WorkerLoopOptions`; wire `WorktreeIsolator` when enabled |
| Modify | `src/orchestration/ResourceManager.ts` | Add `skipWriteLocks?: boolean` to `ResourceConfig`; skip `writeLocks.tryLock()` when set |
| Modify | `tests/unit/ResourceManager.test.ts` | Add 2 tests for the `skipWriteLocks` flag |

---

## Task 1: Worktree primitives in `AgentGitStore`

**Files:**
- Modify: `src/git/AgentGitStore.ts`
- Modify: `tests/unit/AgentGitStore.test.ts`

- [ ] **Step 1: Run baseline**

```
npx vitest run tests/unit/AgentGitStore.test.ts
```
Expected: 11 passed (all existing tests green before any edits).

- [ ] **Step 2: Write failing tests for all 5 primitives**

Append a new `describe("AgentGitStore worktree primitives", ...)` block to `tests/unit/AgentGitStore.test.ts`:

```typescript
import * as fsSync from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

// (existing imports already cover these — no duplicates needed)

describe("AgentGitStore worktree primitives", () => {
  let wt: string; // worktree temp path

  beforeEach(() => {
    wt = ""; // reset between tests
  });

  afterEach(() => {
    if (wt && fsSync.existsSync(wt)) {
      fsSync.rmSync(wt, { recursive: true, force: true });
    }
  });

  async function makeStoreWithCommit(dir: string): Promise<{ store: import("../../src/git/AgentGitStore.js").AgentGitStore; baseSha: string }> {
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    const store = await AgentGitStore.resolve(dir);
    const baseSha = await store.commitTree(
      [{ relativePath: "seed.txt", content: "seed" }],
      "initial",
    );
    await store.setRef("refs/minimum/wt-test/base", baseSha);
    return { store, baseSha };
  }

  it("addWorktree creates an isolated working tree", async () => {
    const { store, baseSha } = await makeStoreWithCommit(tmpDir);
    wt = path.join(os.tmpdir(), `minimum-wt-test-${Date.now()}`);
    await store.addWorktree(wt, baseSha);
    // seed.txt should be checked out in the worktree
    expect(fsSync.existsSync(path.join(wt, "seed.txt"))).toBe(true);
    expect(fsSync.readFileSync(path.join(wt, "seed.txt"), "utf-8")).toBe("seed");
  });

  it("removeWorktree cleans up the worktree registration", async () => {
    const { store, baseSha } = await makeStoreWithCommit(tmpDir);
    wt = path.join(os.tmpdir(), `minimum-wt-rm-${Date.now()}`);
    await store.addWorktree(wt, baseSha);
    await store.removeWorktree(wt, /* force */ true);
    // git worktree list should no longer include our path
    const { stdout } = await import("node:child_process").then(m =>
      m.execFileSync("git", ["-C", tmpDir, "worktree", "list", "--porcelain"]).toString()
    );
    // Unwrap: execFileSync returns Buffer, toString works
    const listOutput = execFileSync("git", ["-C", tmpDir, "worktree", "list", "--porcelain"]).toString();
    expect(listOutput).not.toContain(wt);
    wt = ""; // already removed
  });

  it("captureWorktreeChanges returns null when worktree is clean", async () => {
    const { store, baseSha } = await makeStoreWithCommit(tmpDir);
    wt = path.join(os.tmpdir(), `minimum-wt-clean-${Date.now()}`);
    await store.addWorktree(wt, baseSha);
    const sha = await store.captureWorktreeChanges(wt, "no-op");
    expect(sha).toBeNull();
    await store.removeWorktree(wt, true);
    wt = "";
  });

  it("captureWorktreeChanges returns a commit SHA when files changed", async () => {
    const { store, baseSha } = await makeStoreWithCommit(tmpDir);
    wt = path.join(os.tmpdir(), `minimum-wt-changes-${Date.now()}`);
    await store.addWorktree(wt, baseSha);
    // Simulate task writing a new file in the worktree
    fsSync.writeFileSync(path.join(wt, "result.txt"), "task output", "utf-8");
    const sha = await store.captureWorktreeChanges(wt, "task: add result.txt");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // Verify the file is in the captured commit
    const content = await store.readFileAtCommit(sha!, "result.txt");
    expect(content).toBe("task output");
    await store.removeWorktree(wt, true);
    wt = "";
  });

  it("listChangedFiles lists modified and deleted paths", async () => {
    const { store, baseSha } = await makeStoreWithCommit(tmpDir);
    wt = path.join(os.tmpdir(), `minimum-wt-diff-${Date.now()}`);
    await store.addWorktree(wt, baseSha);
    // Add one file, delete the seed
    fsSync.writeFileSync(path.join(wt, "new.ts"), "export {};", "utf-8");
    fsSync.unlinkSync(path.join(wt, "seed.txt"));
    const toSha = await store.captureWorktreeChanges(wt, "mutate");
    const files = await store.listChangedFiles(baseSha, toSha!);
    const paths = files.map(f => f.path);
    const deleted = files.filter(f => f.deleted).map(f => f.path);
    expect(paths).toContain("new.ts");
    expect(paths).toContain("seed.txt");
    expect(deleted).toContain("seed.txt");
    await store.removeWorktree(wt, true);
    wt = "";
  });

  it("applyCommitFiles writes changed files to targetRoot and removes deleted files", async () => {
    const { store, baseSha } = await makeStoreWithCommit(tmpDir);
    wt = path.join(os.tmpdir(), `minimum-wt-apply-${Date.now()}`);
    await store.addWorktree(wt, baseSha);
    fsSync.writeFileSync(path.join(wt, "out.ts"), "export const x = 1;", "utf-8");
    fsSync.unlinkSync(path.join(wt, "seed.txt"));
    const toSha = await store.captureWorktreeChanges(wt, "produce output");

    // Apply to a fresh temp dir simulating the main working tree
    const target = fsSync.mkdtempSync(path.join(os.tmpdir(), "minimum-apply-"));
    // Pre-create seed.txt so deletion can be tested
    fsSync.writeFileSync(path.join(target, "seed.txt"), "old", "utf-8");
    try {
      await store.applyCommitFiles(toSha!, baseSha, target);
      expect(fsSync.existsSync(path.join(target, "out.ts"))).toBe(true);
      expect(fsSync.readFileSync(path.join(target, "out.ts"), "utf-8")).toBe("export const x = 1;");
      expect(fsSync.existsSync(path.join(target, "seed.txt"))).toBe(false);
    } finally {
      fsSync.rmSync(target, { recursive: true, force: true });
    }
    await store.removeWorktree(wt, true);
    wt = "";
  });

  it("listChangedFiles returns empty array for identical SHAs", async () => {
    const { store, baseSha } = await makeStoreWithCommit(tmpDir);
    const files = await store.listChangedFiles(baseSha, baseSha);
    expect(files).toEqual([]);
  });

  it("addWorktree and removeWorktree are idempotent on force-remove of missing path", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);
    const sha = await store.commitTree(
      [{ relativePath: "a.txt", content: "a" }],
      "base",
    );
    wt = path.join(os.tmpdir(), `minimum-wt-idem-${Date.now()}`);
    await store.addWorktree(wt, sha);
    await store.removeWorktree(wt, true);
    // Second remove should not throw
    await expect(store.removeWorktree(wt, true)).resolves.toBeUndefined();
    wt = "";
  });
});
```

- [ ] **Step 3: Run tests — confirm 8 new tests fail (methods not yet implemented)**

```
npx vitest run tests/unit/AgentGitStore.test.ts
```
Expected: 11 existing pass, ~8 new fail with "store.addWorktree is not a function" or similar.

- [ ] **Step 4: Implement the 5 primitives in `AgentGitStore.ts`**

Add after the `gitLog` method and before `storeBlob`:

```typescript
/**
 * Create a new git worktree at `worktreePath` checked out at `baseSha`.
 * The worktree shares the object store with this repo.
 */
async addWorktree(worktreePath: string, baseSha: string): Promise<void> {
  await this.git(["worktree", "add", "--detach", worktreePath, baseSha]);
}

/**
 * Remove a previously-added worktree from git's registry.
 * Pass `force = true` to remove even if the path no longer exists.
 * Does not throw if the worktree was already removed.
 */
async removeWorktree(worktreePath: string, force?: boolean): Promise<void> {
  const args = ["worktree", "remove", worktreePath];
  if (force) args.push("--force");
  try {
    await this.git(args);
  } catch {
    // Swallow: worktree may already be gone (e.g., cleaned up by OS)
  }
}

/**
 * Stage all changes inside `worktreePath` and create a commit.
 * Returns the new commit SHA, or `null` if the worktree had no changes.
 */
async captureWorktreeChanges(
  worktreePath: string,
  message: string,
): Promise<string | null> {
  // Stage everything
  await execFileAsync("git", ["-C", worktreePath, "add", "-A"]);

  // Exit 0 = no staged diff; exit 1 = staged diff present
  let hasStagedChanges = false;
  try {
    await execFileAsync("git", ["-C", worktreePath, "diff", "--cached", "--quiet"]);
  } catch {
    hasStagedChanges = true;
  }
  if (!hasStagedChanges) return null;

  const identityEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "minimum-agent",
    GIT_AUTHOR_EMAIL: "agent@minimum.local",
    GIT_COMMITTER_NAME: "minimum-agent",
    GIT_COMMITTER_EMAIL: "agent@minimum.local",
  };
  await execFileAsync("git", ["-C", worktreePath, "commit", "-m", message], {
    env: identityEnv,
  });
  const { stdout } = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
  return stdout.trim();
}

/**
 * List files that differ between `fromSha` and `toSha`.
 * Returns `{ path, deleted }` entries.
 */
async listChangedFiles(
  fromSha: string,
  toSha: string,
): Promise<Array<{ path: string; deleted: boolean }>> {
  if (fromSha === toSha) return [];
  try {
    const output = await this.git(["diff", "--name-status", fromSha, toSha]);
    if (!output) return [];
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const status = line.slice(0, tab);
        const filePath = line.slice(tab + 1);
        return { path: filePath, deleted: status === "D" };
      });
  } catch {
    return [];
  }
}

/**
 * Read each file changed between `baseSha` and `commitSha` from the
 * commit object store, then write (or delete) it under `targetRoot`.
 * Safely handles missing/deleted files without throwing.
 */
async applyCommitFiles(
  commitSha: string,
  baseSha: string,
  targetRoot: string,
): Promise<void> {
  const changed = await this.listChangedFiles(baseSha, commitSha);
  for (const { path: relativePath, deleted } of changed) {
    const fullPath = path.join(targetRoot, relativePath);
    if (deleted) {
      await fs.unlink(fullPath).catch(() => {});
    } else {
      const content = await this.readFileAtCommit(commitSha, relativePath);
      if (content !== null) {
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, "utf-8");
      }
    }
  }
}
```

- [ ] **Step 5: Run tests — all 19 pass**

```
npx vitest run tests/unit/AgentGitStore.test.ts
```
Expected: 19 passed (11 original + 8 new).

- [ ] **Step 6: Commit**

```bash
git add src/git/AgentGitStore.ts tests/unit/AgentGitStore.test.ts
git commit -m "feat(git): add worktree primitives to AgentGitStore"
```

---

## Task 2: `WorktreeIsolator` class

**Files:**
- Create: `src/git/WorktreeIsolator.ts`
- Modify: `src/git/index.ts`
- Create: `tests/unit/WorktreeIsolator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/WorktreeIsolator.test.ts`:

```typescript
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGitStore } from "../../src/git/AgentGitStore.js";
import { WorktreeIsolator } from "../../src/git/WorktreeIsolator.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-wti-test-"));
  execFileSync("git", ["init"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const slug = tmpDir.replace(/[/\\:]/g, "-").replace(/^-+/, "");
  fs.rmSync(path.join(os.homedir(), ".minimum", "shadow", slug), {
    recursive: true,
    force: true,
  });
});

async function makeBaseCommit(store: AgentGitStore): Promise<string> {
  return store.commitTree(
    [{ relativePath: "readme.txt", content: "base" }],
    "initial",
  );
}

describe("WorktreeIsolator.create", () => {
  it("returns a path that exists and contains the base commit files", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await makeBaseCommit(store);
    const isolator = new WorktreeIsolator(store);

    const wt = await isolator.create("task-1", baseSha);
    try {
      expect(fs.existsSync(wt)).toBe(true);
      expect(fs.existsSync(path.join(wt, "readme.txt"))).toBe(true);
    } finally {
      await isolator.discard("task-1");
    }
  });
});

describe("WorktreeIsolator.commitAndApply", () => {
  it("returns { sha: null, changedFiles: [] } when no changes made", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await makeBaseCommit(store);
    const isolator = new WorktreeIsolator(store);

    await isolator.create("task-clean", baseSha);
    const result = await isolator.commitAndApply("task-clean", baseSha, "no-op");
    expect(result.sha).toBeNull();
    expect(result.changedFiles).toEqual([]);
    await isolator.discard("task-clean");
  });

  it("captures a new file and applies it to the main working tree", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await makeBaseCommit(store);
    const isolator = new WorktreeIsolator(store);

    const wt = await isolator.create("task-new", baseSha);
    // Simulate task writing a new file inside the worktree
    fs.writeFileSync(path.join(wt, "output.ts"), "export const v = 42;", "utf-8");

    const result = await isolator.commitAndApply("task-new", baseSha, "add output.ts");
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.changedFiles).toContain("output.ts");
    // The file must now exist in the main working tree (tmpDir)
    expect(fs.existsSync(path.join(tmpDir, "output.ts"))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "output.ts"), "utf-8")).toBe("export const v = 42;");
    await isolator.discard("task-new");
  });

  it("removes a deleted file from the main working tree", async () => {
    // Create readme.txt in the main tree so it can be deleted
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "base", "utf-8");

    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await makeBaseCommit(store);
    const isolator = new WorktreeIsolator(store);

    const wt = await isolator.create("task-del", baseSha);
    fs.unlinkSync(path.join(wt, "readme.txt"));

    const result = await isolator.commitAndApply("task-del", baseSha, "delete readme");
    expect(result.changedFiles).toContain("readme.txt");
    expect(fs.existsSync(path.join(tmpDir, "readme.txt"))).toBe(false);
    await isolator.discard("task-del");
  });
});

describe("WorktreeIsolator.discard", () => {
  it("removes the worktree and cleans up the git registration", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await makeBaseCommit(store);
    const isolator = new WorktreeIsolator(store);

    const wt = await isolator.create("task-discard", baseSha);
    expect(fs.existsSync(wt)).toBe(true);

    await isolator.discard("task-discard");
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("is a no-op for an unknown taskId", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    const isolator = new WorktreeIsolator(store);
    // Should not throw
    await expect(isolator.discard("nonexistent-task")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — all 6 fail (file not found)**

```
npx vitest run tests/unit/WorktreeIsolator.test.ts
```
Expected: 6 failed with import error.

- [ ] **Step 3: Implement `WorktreeIsolator.ts`**

Create `src/git/WorktreeIsolator.ts`:

```typescript
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentGitStore } from "./AgentGitStore.js";

export interface WorktreeResult {
  /** The commit SHA capturing the task's changes, or null if no changes. */
  sha: string | null;
  /** Relative paths of files that were written or deleted. */
  changedFiles: string[];
}

/**
 * WorktreeIsolator — per-task git worktree lifecycle manager.
 *
 * Each task gets an isolated copy of the working tree via `git worktree add`.
 * After task completion, changes are committed and applied back to the main tree.
 *
 * Usage:
 *   const iso = new WorktreeIsolator(store);
 *   const wt = await iso.create(taskId, baseSha);
 *   // ... task writes files to wt ...
 *   const result = await iso.commitAndApply(taskId, baseSha, "task: summary");
 *   await iso.discard(taskId);
 */
export class WorktreeIsolator {
  private entries = new Map<string, { worktreePath: string }>();

  constructor(private readonly store: AgentGitStore) {}

  /**
   * Create a new git worktree for `taskId` at a temp path, checked out at `baseSha`.
   * Returns the worktree path (the directory the task should use as its root).
   */
  async create(taskId: string, baseSha: string): Promise<string> {
    const worktreePath = path.join(
      os.tmpdir(),
      `minimum-wt-${taskId.replace(/[^a-zA-Z0-9-]/g, "_")}-${Date.now()}`,
    );
    await this.store.addWorktree(worktreePath, baseSha);
    this.entries.set(taskId, { worktreePath });
    return worktreePath;
  }

  /**
   * Stage all changes in the task's worktree, commit them, and apply the
   * changed files back to the main working tree.
   *
   * Returns:
   *   - `sha`: the new commit SHA, or `null` if the task made no changes
   *   - `changedFiles`: list of relative paths that were written or deleted
   */
  async commitAndApply(
    taskId: string,
    baseSha: string,
    message: string,
  ): Promise<WorktreeResult> {
    const entry = this.entries.get(taskId);
    if (!entry) {
      throw new Error(`WorktreeIsolator: no worktree registered for task "${taskId}"`);
    }
    const sha = await this.store.captureWorktreeChanges(entry.worktreePath, message);
    if (sha === null) {
      return { sha: null, changedFiles: [] };
    }
    const changed = await this.store.listChangedFiles(baseSha, sha);
    await this.store.applyCommitFiles(sha, baseSha, this.store.config.workTree);
    return { sha, changedFiles: changed.map((f) => f.path) };
  }

  /**
   * Remove the worktree from git's registry and delete its directory.
   * Safe to call even if the task was never created or was already discarded.
   */
  async discard(taskId: string): Promise<void> {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    this.entries.delete(taskId);
    await this.store.removeWorktree(entry.worktreePath, /* force */ true);
    await fs.rm(entry.worktreePath, { recursive: true, force: true }).catch(() => {});
  }
}
```

- [ ] **Step 4: Export from `src/git/index.ts`**

Add these two lines to `src/git/index.ts` (keep all existing exports):

```typescript
export { WorktreeIsolator } from "./WorktreeIsolator.js";
export type { WorktreeResult } from "./WorktreeIsolator.js";
```

- [ ] **Step 5: Run tests — all 6 pass**

```
npx vitest run tests/unit/WorktreeIsolator.test.ts
```
Expected: 6 passed.

- [ ] **Step 6: Full git test suite still green**

```
npx vitest run tests/unit/AgentGitStore.test.ts tests/unit/WorktreeIsolator.test.ts
```
Expected: 25 passed total.

- [ ] **Step 7: Commit**

```bash
git add src/git/WorktreeIsolator.ts src/git/index.ts tests/unit/WorktreeIsolator.test.ts
git commit -m "feat(git): add WorktreeIsolator lifecycle manager"
```

---

## Task 3: `ResourceManager` — skip write locks when worktree isolation is active

**Files:**
- Modify: `src/orchestration/ResourceManager.ts`
- Modify: `tests/unit/ResourceManager.test.ts` (create if it doesn't exist)

- [ ] **Step 1: Confirm existing ResourceManager tests (or baseline)**

```
npx vitest run tests/unit/ResourceManager.test.ts
```
If the file doesn't exist, expected output is "no test files found" — that's fine, we'll create it.

- [ ] **Step 2: Write failing tests for `skipWriteLocks`**

If `tests/unit/ResourceManager.test.ts` doesn't exist, create it; otherwise append. The following two tests target the new flag:

```typescript
import { describe, expect, it } from "vitest";
import { ResourceManager } from "../../src/orchestration/ResourceManager.js";

describe("ResourceManager — skipWriteLocks flag", () => {
  it("allows overlapping globs when skipWriteLocks is true", () => {
    const rm = new ResourceManager({ skipWriteLocks: true });

    const r1 = rm.acquire("task-1", "code_writer", ["src/**"], false, false);
    expect(r1.ok).toBe(true);

    // task-2 has the same glob — normally blocked, but skipWriteLocks bypasses it
    const r2 = rm.acquire("task-2", "code_writer", ["src/**"], false, false);
    expect(r2.ok).toBe(true);

    rm.release("task-1", "code_writer", false, false);
    rm.release("task-2", "code_writer", false, false);
  });

  it("blocks overlapping globs when skipWriteLocks is false (default behaviour)", () => {
    const rm = new ResourceManager({ skipWriteLocks: false });

    const r1 = rm.acquire("task-1", "code_writer", ["src/**"], false, false);
    expect(r1.ok).toBe(true);

    const r2 = rm.acquire("task-2", "code_writer", ["src/**"], false, false);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      const types = r2.reasons.map((r) => r.type);
      expect(types).toContain("write_lock");
    }

    rm.release("task-1", "code_writer", false, false);
  });
});
```

- [ ] **Step 3: Run tests — 2 fail**

```
npx vitest run tests/unit/ResourceManager.test.ts
```
Expected: 2 failed (property `skipWriteLocks` not in `ResourceConfig`).

- [ ] **Step 4: Add `skipWriteLocks` to `ResourceConfig` and wire it**

In `src/orchestration/ResourceManager.ts`:

```typescript
// Add to ResourceConfig interface:
export interface ResourceConfig {
  globalMax: number;
  personaCaps: Partial<Record<PersonaId, number>>;
  /** Max concurrent shell/install commands across all tasks. */
  shellMax: number;
  /**
   * When true, skip WriteLockManager gating entirely.
   * Use this when worktree isolation guarantees each task has its own
   * filesystem tree and concurrent writes cannot corrupt each other.
   */
  skipWriteLocks?: boolean;
}
```

In the `acquire()` method, wrap the write-lock block:

```typescript
// 3. Write locks (skip when worktree isolation is active)
if (!this.config.skipWriteLocks) {
  const writeConflicts = this.writeLocks.tryLock(taskId, allowedGlobs);
  if (writeConflicts.length > 0) {
    reasons.push({
      type: "write_lock",
      detail: `blocked by ${writeConflicts.map(w => `${w.taskId} (${w.glob})`).join(", ")}`,
    });
  }
}
```

In `release()`, wrap the unlock:

```typescript
if (!this.config.skipWriteLocks) {
  this.writeLocks.unlock(taskId);
}
```

> **Note:** `writeLocksInfo()` still works correctly — when `skipWriteLocks` is true, `writeLocks` will simply have zero entries since `tryLock` was never called.

- [ ] **Step 5: Run tests — 2 new tests pass**

```
npx vitest run tests/unit/ResourceManager.test.ts
```
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/ResourceManager.ts tests/unit/ResourceManager.test.ts
git commit -m "feat(orchestration): add skipWriteLocks flag to ResourceManager"
```

---

## Task 4: Wire `WorktreeIsolator` into `WorkerLoop` (opt-in)

**Files:**
- Modify: `src/orchestration/WorkerLoop.ts`

> **Context:** `WorkerLoop.runTask()` already creates an `AgentGitStore` at line ~229 via `AgentGitStore.resolve(this.projectRoot)`. The task executor (`this.executor.run(contract, ...)`) runs the LLM in the context of `this.projectRoot`. When worktree isolation is enabled, we create a worktree from the current HEAD before running, run the task (the executor writes to its configured `projectRoot` which should be the worktree path — but this requires the executor to accept a per-run override, see note below), then capture and apply changes after.
>
> **Current limitation:** The `WorkerExecutor` interface (`run(contract, filteredTools, repair?, runOpts?)`) does not accept a `projectRoot` override. The LLM tools are bound at executor construction time. For this iteration, `WorkerLoop` creates the worktree, stores the base SHA, and after the task runs (with the existing `this.projectRoot`), calls `captureWorktreeChanges(worktreeDir)` where `worktreeDir` is the temp path. **But the executor still writes to the main `projectRoot`.** This means Phase 4 wiring establishes the lifecycle hooks and commit metadata, while Phase 5 (WorkerExecutor `projectRoot` override) will complete the isolation. This is intentional incremental delivery.
>
> Concretely: this task adds the plumbing (worktree create → task → capture → apply → discard) and the `worktreeIsolation?: boolean` config flag, verified by a unit test that mocks the executor.

- [ ] **Step 1: Read the `WorkerLoopOptions` interface in `WorkerLoop.ts`**

Confirm `WorkerLoopOptions` has at minimum: `projectRoot: string; executor: WorkerExecutor`.
The change adds `worktreeIsolation?: boolean` to that interface.

- [ ] **Step 2: Add `worktreeIsolation` to `WorkerLoopOptions`**

In `src/orchestration/WorkerLoop.ts`, find the `WorkerLoopOptions` interface and add:

```typescript
export interface WorkerLoopOptions {
  projectRoot: string;
  executor: WorkerExecutor;
  // ... existing fields ...
  /**
   * When true, each task runs inside a git worktree.
   * Changes are committed and applied back to `projectRoot` after completion.
   * Also requires ResourceManager to be configured with `skipWriteLocks: true`.
   */
  worktreeIsolation?: boolean;
}
```

- [ ] **Step 3: Wire `WorktreeIsolator` into `runTask`**

In the `runTask` method (approximately line 229 where `AgentGitStore.resolve` is called), add worktree lifecycle hooks. The existing flow is:

```typescript
const gitStore = await AgentGitStore.resolve(this.projectRoot);
// ... GitSnapshotManager setup ...
// ... run task ...
// ... fire-and-forget checkpoint ...
```

Replace with (add around the existing code, do NOT remove `GitSnapshotManager`):

```typescript
const gitStore = await AgentGitStore.resolve(this.projectRoot);

// Worktree isolation: create an isolated working tree before the task
let worktreeBaseSha: string | null = null;
const isolator = this.options.worktreeIsolation
  ? new WorktreeIsolator(gitStore)
  : null;

if (isolator) {
  try {
    // Get current HEAD to use as the base for this task's worktree
    worktreeBaseSha = await gitStore.readRef("HEAD");
    if (!worktreeBaseSha) {
      // Repo is empty — make a root commit so we have a base SHA
      worktreeBaseSha = await gitStore.commitTree(
        [{ relativePath: ".minimum-init", content: "" }],
        "chore: initialize minimum object store",
      );
      await gitStore.setRef("refs/minimum/init", worktreeBaseSha);
    }
    await isolator.create(input.contract.taskId, worktreeBaseSha);
  } catch (err) {
    // Worktree creation failed — fall back to running without isolation
    void err; // logged by onEvent below if needed
    worktreeBaseSha = null;
  }
}

// ... existing GitSnapshotManager setup and task execution ...
const result = await runTaskWithRetry(input.contract, taskOpts);

// Worktree isolation: commit and apply changes back to main tree
if (isolator && worktreeBaseSha) {
  try {
    await isolator.commitAndApply(
      input.contract.taskId,
      worktreeBaseSha,
      `task(${input.contract.taskId}): apply worktree changes`,
    );
  } catch {
    // Apply failure is non-fatal — task result is already recorded
  } finally {
    await isolator.discard(input.contract.taskId);
  }
}

// ... existing fire-and-forget checkpoint ...
```

Also add the import at the top of `WorkerLoop.ts`:

```typescript
import { WorktreeIsolator } from "../git/WorktreeIsolator.js";
```

- [ ] **Step 4: Run the WorkerLoop-adjacent tests (if any)**

```
npx vitest run tests/unit/WorkerLoop.test.ts
```
If no test file exists, skip. If tests exist, ensure they still pass.

- [ ] **Step 5: Full test suite**

```
npx vitest run tests/unit/
```
Expected: all tests that passed before still pass; no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/WorkerLoop.ts
git commit -m "feat(orchestration): wire WorktreeIsolator into WorkerLoop as opt-in"
```

---

## Task 5: Final integration smoke test + exports audit

**Files:**
- Modify: `src/git/index.ts` (verify only — no new changes expected)

- [ ] **Step 1: Verify all new symbols are exported from `src/git/index.ts`**

Read `src/git/index.ts` and confirm these exports are present:

```typescript
export { WorktreeIsolator } from "./WorktreeIsolator.js";
export type { WorktreeResult } from "./WorktreeIsolator.js";
```

If missing (should have been added in Task 2 Step 4), add them now.

- [ ] **Step 2: TypeScript build passes**

```
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Full unit test suite**

```
npx vitest run tests/unit/
```
Expected: all tests pass. New coverage from Phase 4:
- `AgentGitStore` — 5 new primitives, 8 new tests (total: 19)
- `WorktreeIsolator` — 6 new tests
- `ResourceManager` — 2 new tests

- [ ] **Step 4: Final commit (if any outstanding changes)**

```bash
git add -p  # review and stage any remaining changes
git commit -m "chore(git): Phase 4 exports audit and final integration"
```

---

## What Phase 4 delivers

| Capability | Status |
|------------|--------|
| `AgentGitStore.addWorktree` | ✅ Done |
| `AgentGitStore.removeWorktree` | ✅ Done |
| `AgentGitStore.captureWorktreeChanges` | ✅ Done |
| `AgentGitStore.listChangedFiles` | ✅ Done |
| `AgentGitStore.applyCommitFiles` | ✅ Done |
| `WorktreeIsolator` lifecycle | ✅ Done |
| `ResourceManager.skipWriteLocks` flag | ✅ Done |
| `WorkerLoop` worktree opt-in hooks | ✅ Done (lifecycle only) |
| Full executor `projectRoot` override | 🔜 Phase 5 |

**Phase 5 follow-up:** Extend `WorkerExecutor.run()` to accept a `projectRoot` override per-run. Pass the worktree path as that override so the LLM's file tools actually write inside the isolated tree, not the main `projectRoot`. This completes the isolation boundary. The `WorktreeIsolator.commitAndApply()` call in `WorkerLoop` then captures those writes correctly.
