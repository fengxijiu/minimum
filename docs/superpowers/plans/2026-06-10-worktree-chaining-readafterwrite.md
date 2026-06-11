# Worktree Chaining — Cross-Wave Read-After-Write Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Prerequisite:** This plan depends on the pipeline-wide `runId` from `docs/superpowers/plans/2026-06-10-worktree-isolation-hardening.md` **Task 6**. Land that first.

**Goal:** Make downstream isolated tasks see upstream tasks' output inside their own worktree, so dependency chains (scaffold → implement → test, all touching related files) work under `worktreeIsolation` instead of every task forking from a stale main `HEAD`.

**Architecture:** Maintain one **run-level integrated ref** `refs/minimum/<runId>/integrated`, initialised to the main `HEAD` commit at pipeline start. Every isolated task forks its worktree from the *current* integrated ref instead of `HEAD`. When a task's non-conflicting changes are applied back, the integrated ref is advanced (compare-and-swap) to a new commit that overlays those changes onto the previous integrated tree. The next task to launch forks from the advanced ref and therefore contains all prior output. The integrated ref is the run's incremental integration branch; at the end it equals the merged result.

**Tech Stack:** TypeScript (ESM), Vitest, existing `AgentGitStore` / `WorktreeIsolator` / `WorkerLoop` / `DynamicHarness` / `MiMoPipeline`.

---

## Why the current design misses this

`WorkerLoop.runTask` computes `worktreeBaseSha = await gitStore.readRef("HEAD")` and `WorktreeIsolator.create` runs `git worktree add --detach <path> <baseSha>`. Apply-back writes files to the **main working directory** (uncommitted) — it never advances `HEAD`. So a downstream task's worktree, forked from `HEAD`, checks out the original tree and cannot see any upstream apply-back. Non-conflicting immediate apply-back keeps the *shared* working dir current, but not the *isolated worktrees*.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/git/AgentGitStore.ts` | `overlayCommit` (build integrated commit), `compareAndSwapRef` (atomic ref advance) |
| Modify | `src/orchestration/WorkerLoop.ts` | fork worktree from the integrated ref; advance it on apply-back (CAS + retry) |
| Modify | `src/orchestration/MiMoPipeline.ts` | initialise `refs/minimum/<runId>/integrated` at pipeline start |
| Create | `tests/unit/worktree-chaining.test.ts` | integrated-ref advance, CAS retry, downstream-sees-upstream |

---

## Task 1: Integrated-commit + compare-and-swap primitives

**Files:** `src/git/AgentGitStore.ts`; `tests/unit/worktree-chaining.test.ts`.

- [ ] **Step 1: Failing test**

```typescript
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGitStore } from "../../src/git/AgentGitStore.js";

describe("integrated-ref primitives", () => {
	let dir: string; let store: AgentGitStore;
	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-"));
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "init"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "ignore" });
		store = await AgentGitStore.resolve(dir);
	});
	afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win */ } });

	it("overlayCommit stacks a task's changed files onto a base commit", async () => {
		const head = (await store.readRef("HEAD"))!;
		// a worktree commit that adds src/a.ts
		const taskCommit = await store.commitTree([{ relativePath: "src/a.ts", content: "A" }], "task", { parent: head });
		const integrated = await store.overlayCommit(head, taskCommit, head, `integrate`);
		expect(await store.readFileAtCommit(integrated, "src/a.ts")).toBe("A");
	});

	it("compareAndSwapRef only advances when the expected old value matches", async () => {
		const head = (await store.readRef("HEAD"))!;
		const next = await store.commitTree([{ relativePath: "x", content: "1" }], "n", { parent: head });
		await store.setRef("refs/minimum/run/integrated", head);
		expect(await store.compareAndSwapRef("refs/minimum/run/integrated", head, next)).toBe(true);
		// stale old value → refused
		expect(await store.compareAndSwapRef("refs/minimum/run/integrated", head, next)).toBe(false);
		expect(await store.readRef("refs/minimum/run/integrated")).toBe(next);
	});
});
```

- [ ] **Step 2: Run — confirm failure** (`overlayCommit` / `compareAndSwapRef` missing)
```
npx vitest run tests/unit/worktree-chaining.test.ts
```

- [ ] **Step 3: Implement the primitives** in `src/git/AgentGitStore.ts`:

```typescript
  /**
   * Build a new commit whose tree = `baseCommit`'s tree with every file that
   * changed between `taskBaseSha..taskCommitSha` overlaid (added/modified/deleted).
   * Returns the new commit sha. Used to advance the run's integrated ref.
   */
  async overlayCommit(
    baseCommit: string,
    taskCommitSha: string,
    taskBaseSha: string,
    message: string,
  ): Promise<string> {
    const tmpIdx = path.join(os.tmpdir(), `minimum-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const idxEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tmpIdx };
      // Seed the index with baseCommit's tree, then apply the task's diff on top.
      await this.git(["read-tree", baseCommit], { env: idxEnv });
      const changed = await this.listChangedFiles(taskBaseSha, taskCommitSha);
      for (const { path: rel, deleted } of changed) {
        if (deleted) {
          await this.git(["update-index", "--force-remove", rel], { env: idxEnv }).catch(() => {});
        } else {
          const oid = await this.blobOidAtCommit(taskCommitSha, rel); // from hardening Task 7
          if (oid) await this.git(["update-index", "--add", "--cacheinfo", `100644,${oid},${rel}`], { env: idxEnv });
        }
      }
      const treeSha = await this.git(["write-tree"], { env: idxEnv });
      return await this.git(["commit-tree", treeSha, "-p", baseCommit, "-m", message], {
        env: { ...idxEnv, GIT_AUTHOR_NAME: "minimum-agent", GIT_AUTHOR_EMAIL: "agent@minimum.local", GIT_COMMITTER_NAME: "minimum-agent", GIT_COMMITTER_EMAIL: "agent@minimum.local" },
      });
    } finally {
      await fs.unlink(tmpIdx).catch(() => {});
    }
  }

  /** Atomically move `ref` from `oldSha` to `newSha`. Returns false if `ref` no longer equals `oldSha`. */
  async compareAndSwapRef(ref: string, oldSha: string, newSha: string): Promise<boolean> {
    try {
      await this.git(["update-ref", ref, newSha, oldSha]);
      return true;
    } catch {
      return false;
    }
  }
```
> `overlayCommit` reuses `blobOidAtCommit` from hardening Task 7; if that task is not yet landed, add it here. `git update-ref <ref> <new> <old>` is git's native compare-and-swap.

- [ ] **Step 4: Run — confirm pass**
```
npx vitest run tests/unit/worktree-chaining.test.ts
```

- [ ] **Step 5: Commit**
```bash
git add src/git/AgentGitStore.ts tests/unit/worktree-chaining.test.ts
git commit -m "feat(git): overlayCommit + compareAndSwapRef for run-level integration ref"
```

---

## Task 2: Initialise the integrated ref at pipeline start

**Files:** `src/orchestration/MiMoPipeline.ts`.

- [ ] **Step 1:** At the start of the run (where the pipeline-wide `runId` is minted — hardening Task 6), seed the integrated ref to current HEAD:

```typescript
	const store = await AgentGitStore.resolve(opts.projectRoot);
	const head = await store.readRef("HEAD");
	if (head) await store.setRef(`refs/minimum/${runId}/integrated`, head);
```
> Guard for an empty repo (no HEAD): fall back to the init commit the worktree path already creates, or skip seeding (Task 3 treats a missing integrated ref as "use HEAD").

- [ ] **Step 2:** Build + commit (no behaviour change yet — verified by Task 3).
```bash
npx tsc --noEmit
git add src/orchestration/MiMoPipeline.ts
git commit -m "feat(pipeline): seed run-level integrated ref at HEAD on pipeline start"
```

---

## Task 3: Fork worktrees from the integrated ref and advance it on apply-back

**Files:** `src/orchestration/WorkerLoop.ts`; `tests/unit/worktree-chaining.test.ts`.

- [ ] **Step 1: Failing test** — two sequential isolated tasks; the second's worktree sees the first's file.

```typescript
it("a downstream isolated task forks from the integrated ref and sees upstream output", async () => {
	// Run task A (writes upstream.ts) then task B (reads it) through two WorkerLoop.runTask
	// calls sharing one runId + projectRoot. Assert B's tool received upstream.ts in its
	// worktree (capture the file's presence at B's effectiveRoot via a recording tool host).
	// ...set up loop with worktreeIsolation:true and runId:"run_chain"...
	// Expectation: B's workingDirectory contained upstream.ts written by A.
});
```
> Build this with the recording-tool-host pattern from `worktree-isolation-hardening.test.ts`: task A's tool writes `upstream.ts`; task B's tool reads `fs.existsSync(path.join(ctx.workingDirectory, "upstream.ts"))` and reports it. Assert true.

- [ ] **Step 2: Run — confirm failure** (B forks from HEAD, upstream.ts absent)

- [ ] **Step 3: Use the integrated ref as the worktree base** in `WorkerLoop.runTask`:

```typescript
		const integratedRef = `refs/minimum/${runId}/integrated`;
		// ...inside the isolator setup, replace `worktreeBaseSha = await gitStore.readRef("HEAD")`:
				worktreeBaseSha = (await gitStore.readRef(integratedRef)) ?? (await gitStore.readRef("HEAD"));
```
(`runId` is `input.runId ?? fallback` from hardening Task 6.)

- [ ] **Step 4: Advance the integrated ref after a non-conflicting apply-back** (where `worktreeApply` is handled, after `commitAndApply`):

```typescript
			if (worktreeApply && worktreeApply.sha && worktreeBaseSha) {
				// Advance the run's integrated ref so later tasks fork from a tree that
				// includes this task's applied (non-conflicting) changes. CAS-retry to
				// serialise against other tasks completing concurrently.
				for (let attempt = 0; attempt < 5; attempt++) {
					const current = (await gitStore.readRef(integratedRef)) ?? worktreeBaseSha;
					const next = await gitStore.overlayCommit(current, worktreeApply.sha, worktreeBaseSha, `integrate(${input.contract.taskId})`);
					if (await gitStore.compareAndSwapRef(integratedRef, current, next)) break;
				}
			}
```
> Conflicting files are excluded from the integrated ref automatically: they were never applied (Task 2 of the hardening plan), and `overlayCommit` overlays the task commit's changed files onto the *current* integrated tree — a conflicting file's main-tree version stays authoritative until the W4 master merge writes the resolved content. (Optional: also advance the ref once more after the W4 merge so the final integrated tree matches the merged main tree.)

- [ ] **Step 5: Run — confirm pass**
```
npx vitest run tests/unit/worktree-chaining.test.ts
```

- [ ] **Step 6: Guard concurrency + no-isolation paths — run the broader suites**
```
npx vitest run tests/unit/worktree-chaining.test.ts tests/unit/worktree-isolation-hardening.test.ts tests/unit/dynamic-harness.test.ts tests/unit/worker-loop.test.ts
```
Expected: when `worktreeIsolation` is off, `integratedRef` is never read/advanced (the isolator branch is skipped) — behaviour unchanged.

- [ ] **Step 7: Commit**
```bash
git add src/orchestration/WorkerLoop.ts tests/unit/worktree-chaining.test.ts
git commit -m "feat(worktree): fork tasks from the run integrated ref and advance it on apply-back (read-after-write)"
```

---

## Task 4: Final verification

- [ ] **Step 1:** `npx tsc --noEmit` → zero errors.
- [ ] **Step 2:** `npx vitest run tests/unit/worktree-chaining.test.ts tests/unit/worktree-isolation-hardening.test.ts tests/unit/AgentGitStore.test.ts tests/unit/dynamic-harness.test.ts`
- [ ] **Step 3:** `npx vitest run` → failure count ≤ baseline; any *new* failure is a regression.
- [ ] **Step 4:** Commit any cleanup.

---

## What this plan delivers

| Before | After |
|--------|-------|
| every isolated task forks from stale main `HEAD` | tasks fork from the run's advancing `integrated` ref |
| downstream worktree cannot see upstream output | downstream worktree contains all prior non-conflicting output |
| dependency chains broken under isolation | scaffold → implement → test chains work in isolation |

**Composition with the hardening plan:** the integrated ref provides the clean per-task base; base-divergence conflict detection + the W4 master LLM merge (hardening Tasks 2–3) still handle genuinely overlapping edits. Concurrency is safe via `git update-ref` compare-and-swap with bounded retry.

**Out of scope:** rebasing in-flight worktrees when the integrated ref advances mid-task (a task that started before an upstream completed keeps its original base; its own apply-back is still conflict-checked against base, so divergence is caught — it simply will not have mid-run output it didn't depend on).
