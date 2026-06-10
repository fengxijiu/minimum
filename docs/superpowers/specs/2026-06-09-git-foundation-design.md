# Git Foundation for minimum

**Date:** 2026-06-09
**Status:** Approved

---

## Overview

Replace minimum's fragmented persistence mechanisms (in-memory `SnapshotManager`, JSON-based `CheckpointManager`, and `WriteLockManager` for concurrency) with a single unified foundation: **Agent Git Layer (AGL)**. All file rollback, worker isolation, audit history, and session state are views over one git object store + `refs/minimum/*` discipline.

---

## Core Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where agent commits live | `refs/minimum/*` in user's `.git` | Shared object store (dedup), zero branch pollution, single code path |
| Non-git directories | Auto-shadow at `~/.minimum/shadow/<repo>` | Same `refs/minimum/*` discipline — one code path for both cases |
| User staging area | Never touched (isolated GIT_INDEX_FILE) | User can always `git add` normally |

---

## Architecture

### AgentGitStore (new: `src/git/AgentGitStore.ts`)

The single shared primitive. Resolves which object store to use, then exposes commit/ref/worktree operations. Nothing else touches git directly.

```
AgentGitStore
  resolve(projectRoot) →
    ├ has .git  → user's object store
    └ no  .git  → ~/.minimum/shadow/<repoSlug>/.git

  Primitives:
    commitTree(files: FileChange[])            → sha
    setRef(ref: string, sha: string)           → void
    readRef(ref: string)                       → sha | null
    addWorktree(baseSha: string)               → worktreePath
    removeWorktree(worktreePath: string)       → void
    promote(sha: string, targetBranch: string) → commitSha
```

All `commitTree` calls use a temporary `GIT_INDEX_FILE` — the user's index is never touched.

### Ref Naming Convention

```
refs/minimum/<runId>/task/<taskId>          ← A: per-task file snapshot
refs/minimum/<runId>/checkpoint/<phase>     ← C: audit checkpoints
refs/minimum/<runId>/session                ← D: session/conversation state
refs/minimum/<runId>/worker/<workerId>/tip  ← B: active worktree tip
```

`<runId>` = `run_<timestamp>_<random>` — unique per pipeline/loop invocation.

---

## Sub-Project A — Git-Backed File State & Rollback

**Replaces:** `src/loop/SnapshotManager.ts`

**Responsibility:** Turn every agent file edit into a commit under `refs/minimum/<runId>/task/<taskId>`. Rollback = `read-tree` from a prior commit, not an in-memory buffer restore.

**Interface** (drop-in compatible with current callers in `WorkerLoop` and `MiMoLoop`):
```typescript
class GitSnapshotManager {
  snapshotBeforeEdit(filePath: string): Promise<void>
  rollbackTo(sha: string): Promise<boolean>
  currentSha(): string | null
  reset(): void
}
```

**Commit granularity:** One commit per `edit_file` / `write_file` call. The commit message carries the tool name and args as a trailer for C (audit) to consume.

**Key difference from current SnapshotManager:**
- Survives process crash (commits are on disk)
- Can roll back to any prior step, not just the snapshot before the last edit
- Cross-task rollback is possible (via ref lookup)

---

## Sub-Project B — Worktree Isolation for Parallel Workers

**Replaces:** `WriteLockManager` glob-overlap serialization

**Responsibility:** Each parallel worker gets `git worktree add` at a base commit, runs in isolation, then commits its result back. Concurrency conflicts become merge operations rather than lock waits.

**Integration point:** `DynamicHarness.drainQueue()` — instead of `writeLocks.tryLock()`, call `store.addWorktree(baseSha)` and set worker's `projectRoot` to the returned path. On completion, `commitTree` the results and remove the worktree.

**Merge strategy (post-task):**
1. Three-way merge back to main working tree
2. On conflict: mark task `blocked`, surface conflict to user/orchestrator — do not silently overwrite

**Depends on:** Sub-project A (needs real commits as base points)

---

## Sub-Project C — Run History / Audit Refs

**Replaces:** `CheckpointManager` file-state portions

**Responsibility:** Annotate A's commits with structured metadata; checkpoint = ref at a pipeline phase boundary. Enables "browse a run" after the fact.

**Metadata schema** (git commit trailers):
```
Minimum-Run: <runId>
Minimum-Task: <taskId>
Minimum-Persona: <personaId>
Minimum-Tool: <toolName>
Minimum-Phase: w1|w2|w3|w4
```

**Phase checkpoints:**
```
refs/minimum/<runId>/checkpoint/w1-complete
refs/minimum/<runId>/checkpoint/w3-complete
refs/minimum/<runId>/checkpoint/done
```

**Browse surface:** CLI subcommand `minimum history [runId]` — lists runs, shows per-task commits and tools. TUI panel is out of scope for this sub-project.

**Depends on:** Sub-project A (annotates A's commits)

---

## Sub-Project D — Session State in Git

**Replaces:** `CheckpointManager` / `SessionManager` JSON persistence at `~/.minimum/`

**Responsibility:** Persist conversation messages as git blobs/trees under `refs/minimum/<runId>/session`. Each checkpoint = a commit on that ref.

**Serialization:** One blob per message (`<index>-<role>.json`), collected into a tree per checkpoint. This makes diffs between checkpoints human-readable with `git diff`.

**Interface** (preserves existing signatures):
```typescript
createCheckpoint(sessionId, messages, metadata): Promise<Checkpoint>
restoreCheckpoint(checkpointId): Promise<Checkpoint | null>
listCheckpoints(sessionId?): Promise<Checkpoint[]>
```

Internally, `checkpointId` becomes a git sha rather than a random string. `sessionId` maps to `runId`.

**Independent of A/B/C** — can be built in parallel.

---

## Build Order

```
AgentGitStore  (foundation — no deps)
      │
      ├──► A  Git-Backed Rollback     (replaces SnapshotManager)
      │         │
      │         ├──► C  Audit Refs    (annotates A's commits, low cost)
      │         │
      │         └──► B  Worktree ISO  (highest risk, replaces WriteLockManager)
      │
      └──► D  Session in Git          (parallel, independent)
```

Recommended sequence: **AgentGitStore → A → C → D → B**

B is last because it changes `DynamicHarness` scheduling logic — the highest blast radius change in the stack.

---

## What Is NOT Changing

- `GitTool.ts` (LLM-facing tool) — untouched
- `refs/minimum/*` are never pushed to remote by default
- User's `git status`, `git diff`, staging area — untouched throughout
- TUI / PipelineBridge / MiMoLoop public APIs — only internal persistence swapped out

---

## Windows Considerations

- All git operations via `execFile('git', ...)` with explicit `cwd` — no shell interpolation
- Shadow repo path: `path.join(os.homedir(), '.minimum', 'shadow', slugify(projectRoot))`  where `slugify` replaces `:` and `\` with `-` and `/`
- Worktrees: use short absolute paths; avoid spaces in worktree paths (use `tmp` under `~/.minimum/worktrees/<runId>/`)
- `GIT_INDEX_FILE` env var: must be an absolute path — resolve before passing to `execFile`
