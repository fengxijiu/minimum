# Git Foundation — Phase 3: Session State in Git

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `CheckpointManager`'s JSON-file checkpoint storage with a git-backed `GitCheckpointManager` that stores each checkpoint as a commit under `refs/minimum/<sessionId>/session`, keeping the existing `SessionManager` API and all caller signatures unchanged.

**Architecture:** Each checkpoint is a git commit whose tree contains `checkpoint.json` (metadata + message count) and `messages/0000.json … messages/NNNN.json` (one file per chat message). Commits are chained on `refs/minimum/<sessionId>/session` so the full history is walkable with `git log`. `GitCheckpointManager` is dependency-injected into `SessionManager` via an `ICheckpointManager` interface; the JSON session files at `~/.minimum/sessions/` are unchanged. `createMiMoStack.ts` is the only caller that changes — it passes a `GitCheckpointManager` to `SessionManager`.

**Tech Stack:** TypeScript (ESM), Node.js `child_process`, Vitest, existing `AgentGitStore` from Phase 1/2

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/git/AgentGitStore.ts` | Add `gitLog(ref, maxCount?)` primitive |
| Modify | `tests/unit/AgentGitStore.test.ts` | Add 3 tests for `gitLog` |
| Modify | `src/session/types.ts` | Add `ICheckpointManager` interface |
| Create | `src/session/GitCheckpointManager.ts` | Git-backed checkpoint storage |
| Modify | `src/session/SessionManager.ts` | Accept optional `ICheckpointManager` in constructor |
| Modify | `src/session/index.ts` | Export `GitCheckpointManager`, `ICheckpointManager` |
| Modify | `src/config/createMiMoStack.ts` | Pass `GitCheckpointManager` to `SessionManager` |
| Create | `tests/unit/GitCheckpointManager.test.ts` | 7 integration tests |

---

## Task 1: `gitLog` primitive in `AgentGitStore`

**Files:**
- Modify: `src/git/AgentGitStore.ts`
- Modify: `tests/unit/AgentGitStore.test.ts`

- [ ] **Step 1: Run baseline — confirm 8 tests pass**

```
npx vitest run tests/unit/AgentGitStore.test.ts
```
Expected: 8 passed.

- [ ] **Step 2: Add 3 failing tests to `tests/unit/AgentGitStore.test.ts`**

Append a new `describe` block after all existing tests:

```typescript
describe("AgentGitStore.gitLog", () => {
  it("returns SHAs in reverse-chronological order", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);

    const sha1 = await store.commitTree(
      [{ relativePath: "a.txt", content: "a" }],
      "first",
      {},
    );
    await store.setRef("refs/minimum/run-log/test", sha1);

    const sha2 = await store.commitTree(
      [{ relativePath: "b.txt", content: "b" }],
      "second",
      { parent: sha1 },
    );
    await store.setRef("refs/minimum/run-log/test", sha2);

    const log = await store.gitLog("refs/minimum/run-log/test");
    expect(log).toHaveLength(2);
    expect(log[0]).toBe(sha2); // most recent first
    expect(log[1]).toBe(sha1);
  });

  it("returns empty array for a missing ref", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);
    expect(await store.gitLog("refs/minimum/does-not-exist")).toEqual([]);
  });

  it("respects maxCount", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);

    let parent: string | undefined;
    const shas: string[] = [];
    for (let i = 0; i < 5; i++) {
      const sha = await store.commitTree(
        [{ relativePath: `f${i}.txt`, content: `${i}` }],
        `commit ${i}`,
        { parent },
      );
      parent = sha;
      shas.push(sha);
    }
    await store.setRef("refs/minimum/run-log/many", parent!);

    const log = await store.gitLog("refs/minimum/run-log/many", 3);
    expect(log).toHaveLength(3);
    expect(log[0]).toBe(shas[4]); // most recent
  });
});
```

- [ ] **Step 3: Run tests — expect 3 new failures**

```
npx vitest run tests/unit/AgentGitStore.test.ts
```
Expected: `store.gitLog is not a function` on the new tests.

- [ ] **Step 4: Add `gitLog` method to `src/git/AgentGitStore.ts`**

Add after the `forEachRef` method:

```typescript
  /**
   * Return commit SHAs reachable from `ref` in reverse-chronological order.
   * Returns an empty array if the ref does not exist or the repo is empty.
   */
  async gitLog(ref: string, maxCount?: number): Promise<string[]> {
    try {
      const args = ["log", "--format=%H"];
      if (maxCount !== undefined) args.push(`--max-count=${maxCount}`);
      args.push(ref);
      const output = await this.git(args);
      if (!output) return [];
      return output.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }
```

- [ ] **Step 5: Run tests — expect all 11 pass**

```
npx vitest run tests/unit/AgentGitStore.test.ts
```
Expected: 11 passed (8 original + 3 new).

- [ ] **Step 6: Typecheck**

```
npx tsc --noEmit
```
Expected: same pre-existing errors as before (WaveScheduler/WaveHarness), zero new errors.

- [ ] **Step 7: Commit**

```bash
git add src/git/AgentGitStore.ts tests/unit/AgentGitStore.test.ts
git commit -m "feat(git): gitLog primitive — walk commit history from a ref"
```

---

## Task 2: `ICheckpointManager` interface + `GitCheckpointManager`

**Files:**
- Modify: `src/session/types.ts`
- Create: `src/session/GitCheckpointManager.ts`
- Create: `tests/unit/GitCheckpointManager.test.ts`

- [ ] **Step 1: Add `ICheckpointManager` to `src/session/types.ts`**

The current file is:
```typescript
import type { ChatMessage } from "../types/common.js";

export interface Checkpoint {
  id: string;
  sessionId: string;
  messages: ChatMessage[];
  metadata: Record<string, any>;
  createdAt: number;
}

export interface SessionState {
  id: string;
  messages: ChatMessage[];
  checkpoints: Checkpoint[];
  metadata: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}
```

Add at the end:
```typescript
/** Minimal interface for checkpoint persistence — implemented by both `CheckpointManager` (file-based) and `GitCheckpointManager` (git-backed). */
export interface ICheckpointManager {
  /** Optional lifecycle hook — called by `SessionManager.initialize()` if present. */
  initialize?(): Promise<void>;
  createCheckpoint(sessionId: string, messages: ChatMessage[], metadata?: Record<string, unknown>): Promise<Checkpoint>;
  restoreCheckpoint(checkpointId: string): Promise<Checkpoint | null>;
  listCheckpoints(sessionId?: string): Promise<Checkpoint[]>;
}
```

- [ ] **Step 2: Write failing tests in `tests/unit/GitCheckpointManager.test.ts`**

```typescript
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCheckpointManager } from "../../src/session/GitCheckpointManager.js";

let tmpDir: string;
let manager: GitCheckpointManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-gcp-"));
  execFileSync("git", ["init"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
  manager = new GitCheckpointManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const slug = tmpDir.replace(/[/\\:]/g, "-").replace(/^-+/, "");
  const shadowBase = path.join(os.homedir(), ".minimum", "shadow", slug);
  fs.rmSync(shadowBase, { recursive: true, force: true });
});

describe("GitCheckpointManager.createCheckpoint", () => {
  it("returns a Checkpoint with a 40-char SHA id", async () => {
    const msgs = [{ role: "user", content: "hello" }];
    const cp = await manager.createCheckpoint("session-1", msgs, { type: "test" });
    expect(cp.id).toMatch(/^[0-9a-f]{40}$/);
    expect(cp.sessionId).toBe("session-1");
    expect(cp.messages).toEqual(msgs);
    expect(cp.metadata).toEqual({ type: "test" });
    expect(cp.createdAt).toBeGreaterThan(0);
  });

  it("chains multiple checkpoints so each has a unique SHA", async () => {
    const cp1 = await manager.createCheckpoint("session-2", [
      { role: "user", content: "a" },
    ]);
    const cp2 = await manager.createCheckpoint("session-2", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    expect(cp1.id).not.toBe(cp2.id);
    expect(cp2.id).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("GitCheckpointManager.restoreCheckpoint", () => {
  it("returns the original messages and metadata by SHA", async () => {
    const msgs = [
      { role: "user", content: "test msg" },
      { role: "assistant", content: "reply" },
    ];
    const cp = await manager.createCheckpoint("session-3", msgs, { tag: "v1" });

    const restored = await manager.restoreCheckpoint(cp.id);
    expect(restored).not.toBeNull();
    expect(restored!.messages).toEqual(msgs);
    expect(restored!.metadata).toEqual({ tag: "v1" });
    expect(restored!.sessionId).toBe("session-3");
    expect(restored!.id).toBe(cp.id);
  });

  it("returns null for an unknown SHA", async () => {
    const result = await manager.restoreCheckpoint("a".repeat(40));
    expect(result).toBeNull();
  });
});

describe("GitCheckpointManager.listCheckpoints", () => {
  it("lists checkpoints for a session in reverse-chronological order", async () => {
    await manager.createCheckpoint("session-4", [{ role: "user", content: "1" }]);
    await manager.createCheckpoint("session-4", [{ role: "user", content: "2" }]);
    await manager.createCheckpoint("session-4", [{ role: "user", content: "3" }]);

    const list = await manager.listCheckpoints("session-4");
    expect(list).toHaveLength(3);
    // Most recent first
    expect(list[0].messages[0].content).toBe("3");
    expect(list[2].messages[0].content).toBe("1");
  });

  it("returns empty array for a session with no checkpoints", async () => {
    expect(await manager.listCheckpoints("no-such-session")).toEqual([]);
  });

  it("lists checkpoints across all sessions when no sessionId given", async () => {
    await manager.createCheckpoint("session-5a", [
      { role: "user", content: "x" },
    ]);
    await manager.createCheckpoint("session-5b", [
      { role: "user", content: "y" },
    ]);

    const list = await manager.listCheckpoints();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const sessions = new Set(list.map((c) => c.sessionId));
    expect(sessions.has("session-5a")).toBe(true);
    expect(sessions.has("session-5b")).toBe(true);
  });
});
```

- [ ] **Step 3: Run — expect `Cannot find module '…/GitCheckpointManager.js'`**

```
npx vitest run tests/unit/GitCheckpointManager.test.ts
```

- [ ] **Step 4: Write `src/session/GitCheckpointManager.ts`**

```typescript
import { AgentGitStore } from "../git/AgentGitStore.js";
import type { ChatMessage } from "../types/common.js";
import type { Checkpoint, ICheckpointManager } from "./types.js";

/**
 * Git-backed replacement for `CheckpointManager`.
 *
 * Each checkpoint is a commit under `refs/minimum/<sessionId>/session`.
 * The commit tree contains:
 *   - `checkpoint.json`  — `{ sessionId, metadata, createdAt, messageCount }`
 *   - `messages/0000.json` … `messages/NNNN.json` — one per message
 *
 * The `id` field of the returned `Checkpoint` is the commit SHA —
 * an opaque 40-character hex string compatible with the existing interface.
 */
export class GitCheckpointManager implements ICheckpointManager {
  private storePromise: Promise<AgentGitStore> | null = null;

  constructor(private readonly projectRoot: string) {}

  private getStore(): Promise<AgentGitStore> {
    if (!this.storePromise) {
      this.storePromise = AgentGitStore.resolve(this.projectRoot);
    }
    return this.storePromise;
  }

  private sessionRef(sessionId: string): string {
    return `refs/minimum/${sessionId}/session`;
  }

  async createCheckpoint(
    sessionId: string,
    messages: ChatMessage[],
    metadata: Record<string, unknown> = {},
  ): Promise<Checkpoint> {
    const store = await this.getStore();
    const ref = this.sessionRef(sessionId);
    const createdAt = Date.now();

    const files = [
      {
        relativePath: "checkpoint.json",
        content: JSON.stringify(
          { sessionId, metadata, createdAt, messageCount: messages.length },
          null,
          2,
        ),
      },
      ...messages.map((msg, i) => ({
        relativePath: `messages/${String(i).padStart(4, "0")}.json`,
        content: JSON.stringify(msg, null, 2),
      })),
    ];

    const parent = (await store.readRef(ref)) ?? undefined;
    const commitSha = await store.commitTree(
      files,
      `checkpoint: ${sessionId}`,
      {
        parent,
        trailers: { "Minimum-Session": sessionId },
      },
    );
    await store.setRef(ref, commitSha);

    return {
      id: commitSha,
      sessionId,
      messages: [...messages],
      metadata,
      createdAt,
    };
  }

  async restoreCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
    const store = await this.getStore();

    const metaRaw = await store.readFileAtCommit(
      checkpointId,
      "checkpoint.json",
    );
    if (!metaRaw) return null;

    let meta: {
      sessionId: string;
      metadata: Record<string, unknown>;
      createdAt: number;
      messageCount: number;
    };
    try {
      meta = JSON.parse(metaRaw);
    } catch {
      return null;
    }

    const messages: ChatMessage[] = [];
    for (let i = 0; i < meta.messageCount; i++) {
      const raw = await store.readFileAtCommit(
        checkpointId,
        `messages/${String(i).padStart(4, "0")}.json`,
      );
      if (raw === null) return null;
      try {
        messages.push(JSON.parse(raw) as ChatMessage);
      } catch {
        return null;
      }
    }

    return {
      id: checkpointId,
      sessionId: meta.sessionId,
      messages,
      metadata: meta.metadata,
      createdAt: meta.createdAt,
    };
  }

  async listCheckpoints(sessionId?: string): Promise<Checkpoint[]> {
    const store = await this.getStore();

    // Determine which session refs to walk.
    let refsToWalk: Array<{ sid: string }>;
    if (sessionId) {
      const tip = await store.readRef(this.sessionRef(sessionId));
      if (!tip) return [];
      refsToWalk = [{ sid: sessionId }];
    } else {
      const refs = await store.forEachRef("refs/minimum/*/session");
      refsToWalk = refs
        .map(({ ref }) => {
          const m = ref.match(/^refs\/minimum\/([^/]+)\/session$/);
          return m?.[1] ? { sid: m[1] } : null;
        })
        .filter((x): x is { sid: string } => x !== null);
    }

    const checkpoints: Checkpoint[] = [];
    for (const { sid } of refsToWalk) {
      const shas = await store.gitLog(this.sessionRef(sid));
      for (const sha of shas) {
        const cp = await this.restoreCheckpoint(sha);
        if (cp) checkpoints.push(cp);
      }
    }

    return checkpoints.sort((a, b) => b.createdAt - a.createdAt);
  }
}
```

- [ ] **Step 5: Run tests — expect all 7 pass**

```
npx vitest run tests/unit/GitCheckpointManager.test.ts
```
Expected: 7 passed.

- [ ] **Step 6: Typecheck**

```
npx tsc --noEmit
```
Expected: no new errors beyond the pre-existing WaveScheduler/WaveHarness ones.

- [ ] **Step 7: Commit**

```bash
git add src/session/types.ts src/session/GitCheckpointManager.ts tests/unit/GitCheckpointManager.test.ts
git commit -m "feat(session): GitCheckpointManager — git-backed checkpoint storage"
```

---

## Task 3: Wire `GitCheckpointManager` into `SessionManager` + `createMiMoStack`

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `src/session/index.ts`
- Modify: `src/config/createMiMoStack.ts`

- [ ] **Step 1: Run integration tests to confirm baseline**

```
npx vitest run tests/integration/session-workflow.test.ts
```
Expected: 5 passed (tests use file-based `CheckpointManager`).

- [ ] **Step 2: Update `src/session/SessionManager.ts`**

Make two changes:

**Change A — import and field type:**

Find:
```typescript
import { CheckpointManager } from "./CheckpointManager.js";
import type { SessionState } from "./types.js";
```
Replace with:
```typescript
import { CheckpointManager } from "./CheckpointManager.js";
import type { ICheckpointManager, SessionState } from "./types.js";
```

Find:
```typescript
	private checkpointManager: CheckpointManager;
```
Replace with:
```typescript
	private checkpointManager: ICheckpointManager;
```

**Change B — constructor signature:**

Find:
```typescript
	constructor(basePath?: string) {
		// os.homedir() is cross-platform; $HOME alone is empty on Windows and
		// fell back to a literal "~" subdir of the cwd.
		this.basePath =
			basePath || path.join(os.homedir(), ".minimum", "sessions");
		this.checkpointManager = new CheckpointManager();
	}
```
Replace with:
```typescript
	constructor(basePath?: string, checkpointManager?: ICheckpointManager) {
		// os.homedir() is cross-platform; $HOME alone is empty on Windows and
		// fell back to a literal "~" subdir of the cwd.
		this.basePath =
			basePath || path.join(os.homedir(), ".minimum", "sessions");
		this.checkpointManager = checkpointManager ?? new CheckpointManager();
	}
```

**Change C — conditional initialize():**

Find:
```typescript
	async initialize(): Promise<void> {
		await fsPromises.mkdir(this.basePath, { recursive: true });
		await this.checkpointManager.initialize();
	}
```
Replace with:
```typescript
	async initialize(): Promise<void> {
		await fsPromises.mkdir(this.basePath, { recursive: true });
		if (this.checkpointManager.initialize) {
			await this.checkpointManager.initialize();
		}
	}
```

- [ ] **Step 3: Run integration tests — must still pass with no changes**

```
npx vitest run tests/integration/session-workflow.test.ts
```
Expected: 5 passed (tests use `new SessionManager(tempDir)` without DI, so still use file-based `CheckpointManager`).

- [ ] **Step 4: Update `src/session/index.ts`**

Current content:
```typescript
export { CheckpointManager } from "./CheckpointManager.js";
export { SessionManager } from "./SessionManager.js";
export type { Checkpoint, SessionState } from "./types.js";
```
Replace with:
```typescript
export { CheckpointManager } from "./CheckpointManager.js";
export { GitCheckpointManager } from "./GitCheckpointManager.js";
export { SessionManager } from "./SessionManager.js";
export type { Checkpoint, ICheckpointManager, SessionState } from "./types.js";
```

- [ ] **Step 5: Update `src/config/createMiMoStack.ts`**

**Change A — add import:**

After the existing `import { SessionManager } from "../session/SessionManager.js";` line, add:
```typescript
import { GitCheckpointManager } from "../session/GitCheckpointManager.js";
```

**Change B — create `GitCheckpointManager` and pass to `SessionManager`:**

Find:
```typescript
	// SessionManager — automatic session persistence; one instance per stack.
	const sessionManager = new SessionManager();
```
Replace with:
```typescript
	// SessionManager — automatic session persistence; one instance per stack.
	// Use GitCheckpointManager so checkpoints are stored as git commits under
	// refs/minimum/<sessionId>/session rather than JSON files.
	const sessionManager = new SessionManager(
		undefined,
		new GitCheckpointManager(workingDirectory),
	);
```

- [ ] **Step 6: Run all unit + integration tests**

```
npx vitest run tests/unit/AgentGitStore.test.ts tests/unit/GitSnapshotManager.test.ts tests/unit/RunAuditStore.test.ts tests/unit/GitCheckpointManager.test.ts tests/integration/session-workflow.test.ts
```
Expected: 11 + 3 + 6 + 7 + 5 = 32 tests, all pass.

- [ ] **Step 7: Typecheck**

```
npx tsc --noEmit
```
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/session/SessionManager.ts src/session/index.ts src/config/createMiMoStack.ts
git commit -m "feat(session): wire GitCheckpointManager into SessionManager + createMiMoStack"
```

---

## What's Not In This Plan (future phases)

| Phase | What | Plan file |
|-------|------|-----------|
| Phase 4 | Sub-project B — Worktree isolation for parallel workers (replaces WriteLockManager) | `2026-06-09-git-foundation-phase4-worktree.md` |
