# Worktree Isolation Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close five correctness/observability gaps in the worktree-isolation path so that isolated task changes are applied back deterministically, conflicting parallel writes are detected and **deferred to the master agent for an LLM 3-way merge at W4** (never silently overwritten), snapshots/validation operate on the real worktree, and audit checkpoints share one pipeline-wide run id.

**Architecture:** When `worktreeIsolation` is active, every path-sensitive operation targets the task's temp worktree (`effectiveRoot`). Apply-back becomes synchronous and conflict-aware: **non-conflicting** changes are written straight back to the main tree before the task result unlocks downstream tasks; **conflicting** files (where the main tree diverged from the worktree base) are NOT overwritten and NOT blocked — they are recorded as lightweight conflict records that ride up on the `TaskResult`. At **W4**, the master agent (PlannerBridge) is handed each conflict's base/ours/theirs content and produces the merged file, which the pipeline writes to the main tree.

**Tech Stack:** TypeScript (ESM), Vitest, existing `AgentGitStore` / `WorktreeIsolator` / `GitSnapshotManager` / `WorkerLoop` / `DynamicHarness` / `MiMoPipeline` / `PlannerBridge`.

---

## Background — verified current behaviour

| # | Symptom | Current code (verified) |
|---|---------|-------------------------|
| 1 | apply-back is fire-and-forget → race with downstream unlock | `WorkerLoop.runTask` ~406-415: `void isolator.commitAndApply(...).catch().finally()` — no `await` |
| 2 | no 3-way merge / conflict handling → last-write-wins | `AgentGitStore.applyCommitFiles` (~313-332) writes every changed file unconditionally; no base comparison, no conflict report |
| 3 | snapshot path relativised against main root, not worktree | `GitSnapshotManager.snapshot` (~49-51): `path.relative(this.store.config.workTree, abs)` → `../../tmp/...` |
| 4 | validator runs against main root | `WorkerLoop.runValidator` (~739): `workingDirectory: this.projectRoot` |
| 5 | runId is per-task, not per-pipeline | `WorkerLoop.runTask` (~238): `const runId = \`run_${Date.now()}_...\`` |

**Design decisions (confirmed with product owner):**
- **Conflict scope:** only *conflicts* are deferred. Non-conflicting changes apply immediately so downstream tasks read upstream output; the apply-back race is still fixed by `await` (Task 1).
- **Merge owner:** the **master agent LLM** performs the 3-way merge at **W4** (reads base/ours/theirs, emits merged content). Conflicting files are never blocked nor overwritten in the meantime.

---

## File Map

| Action | Path | Responsibility |
|--------|------|------------------------------|
| Modify | `src/git/AgentGitStore.ts` | `applyCommitFilesChecked` — apply non-conflicting, report conflicts |
| Modify | `src/git/WorktreeIsolator.ts` | `commitAndApply` returns conflict records (path + baseSha + taskCommitSha) |
| Modify | `src/orchestration/WorkerLoop.ts` | `await` apply-back; attach conflicts to result; `effectiveRoot` to validator; accept `runId` |
| Modify | `src/orchestration/TaskRunner.ts` | `ConflictRecord` type; `mergeConflicts` on `TaskResult`; thread `runId` |
| Modify | `src/orchestration/ClientAdapters.ts` | map worker conflicts → `TaskResult`; implement `planner.resolveConflict`; forward `runId` |
| Modify | `src/orchestration/MiMoPipeline.ts` | W4: collect conflicts, call master merge, write merged files; one `runId` |
| Modify | `src/orchestration/DagHarness.ts` / `DynamicHarness.ts` | `runId` option + generation |
| Modify | `src/git/GitSnapshotManager.ts` | relativise snapshot path against effective worktree root |
| Create | `tests/unit/worktree-isolation-hardening.test.ts` | synchronous apply, conflict record, snapshot path, validator root, runId |
| Modify | `tests/unit/AgentGitStore.test.ts` | `applyCommitFilesChecked` cases |

**Ordering:** Task 1 (synchronous apply) underpins Task 2 (conflict record). Task 3 (master-merge at W4) consumes Task 2's records. Task 7 (binary safety) supersedes Task 2's apply internals, so do it after Task 2/3 are green. Tasks 4–6 are independent isolation/observability fixes.

---

## Task 1: Make non-conflicting apply-back synchronous

**Problem:** `runTask` returns while `commitAndApply` is still running, so the scheduler may start a downstream task before the upstream's files exist in `projectRoot`.

**Files:** Modify `src/orchestration/WorkerLoop.ts` (apply-back block ~404-415).

- [ ] **Step 1: Write the failing test** — in `tests/unit/worktree-isolation-hardening.test.ts`:

```typescript
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IStreamingClient, IToolHost } from "../../src/loop/MiMoLoop.js";
import type { StreamChunk } from "../../src/clients/MiMoClient.js";
import type { ToolDefinition } from "../../src/types/common.js";
import type { Persona } from "../../src/personas/Persona.js";
import type { TaskContract } from "../../src/orchestration/TaskContract.js";
import { WorkerLoop } from "../../src/orchestration/WorkerLoop.js";

function gitInit(dir: string): void {
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "init"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

const persona: Persona = {
	id: "code_executor", kind: "worker", model: "mimo-v2.5", systemPrompt: "c",
	toolAllowlist: ["write_file"], toolDenylist: [],
	pathPolicy: { canWrite: true, alwaysAllowedGlobs: ["**/*"], forbiddenGlobs: [] },
	maxSteps: 10, maxTokens: 1000, outputSchema: "task_report",
	parallelism: { soloPerWave: false, maxConcurrent: 1 },
};
const contract = { taskId: "t-apply", grantedMcpTools: [] } as unknown as TaskContract;

function writingToolHost(): IToolHost {
	return {
		getDefinitions(): ToolDefinition[] {
			return [{ name: "write_file", description: "w", parameters: { type: "object", properties: {}, required: [] } }];
		},
		async execute(_call, ctx) {
			const root = ctx?.workingDirectory ?? process.cwd();
			fs.writeFileSync(path.join(root, "out.txt"), "isolated-content", "utf-8");
			return { content: "wrote out.txt", isError: false };
		},
	};
}

function oneWriteThenDone(): IStreamingClient {
	let turn = 0;
	return {
		streamChat(): AsyncIterable<StreamChunk> {
			const t = ++turn;
			const chunks: StreamChunk[] = t === 1
				? [{ type: "tool_call", toolCall: { id: "1", type: "function", function: { name: "write_file", arguments: '{"path":"out.txt"}' } } }, { type: "done" }]
				: [{ type: "content", content: "<task_report><status>completed</status></task_report>" }, { type: "done" }];
			return { [Symbol.asyncIterator]() { let i = 0; return { async next() { return i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined as unknown as StreamChunk }; } }; } };
		},
	};
}

describe("worktree apply-back is synchronous", () => {
	let dir: string;
	beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-apply-")); gitInit(dir); });
	afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win */ } });

	it("has applied worktree changes to projectRoot by the time runTask resolves", async () => {
		const loop = new WorkerLoop({ client: oneWriteThenDone(), tools: writingToolHost(), projectRoot: dir, worktreeIsolation: true });
		await loop.runTask({ systemPrompt: "s", userPrompt: "write", persona, contract, maxSteps: 5 });
		expect(fs.existsSync(path.join(dir, "out.txt"))).toBe(true);
		expect(fs.readFileSync(path.join(dir, "out.txt"), "utf-8")).toBe("isolated-content");
	});
});
```

- [ ] **Step 2: Run — confirm failure**
```
npx vitest run tests/unit/worktree-isolation-hardening.test.ts -t "synchronous"
```

- [ ] **Step 3: Await the apply-back.** In `WorkerLoop.runTask`, replace the fire-and-forget block with:

```typescript
		// Worktree isolation: commit + apply NON-conflicting changes back to the main
		// tree BEFORE returning, so the scheduler never unlocks a downstream task
		// before this task's files exist in projectRoot. Conflicts (Task 2) ride up
		// on the result for the master to merge at W4.
		let worktreeApply: WorktreeResult | undefined;
		if (isolator && worktreeBaseSha) {
			try {
				worktreeApply = await isolator.commitAndApply(
					input.contract.taskId,
					worktreeBaseSha,
					`task(${input.contract.taskId}): apply worktree changes`,
				);
			} catch (err) {
				emit({ type: "content", delta: `\n[worktree] apply failed: ${err instanceof Error ? err.message : String(err)}` });
			} finally {
				await isolator.discard(input.contract.taskId).catch(() => {});
			}
		}
```

Add the type import alongside the existing git import:
```typescript
import type { WorktreeResult } from "../git/index.js";
```
> `worktreeApply` is consumed in Task 2 Step 6. Until then add `void worktreeApply;` if your linter flags it.

- [ ] **Step 4: Run — confirm pass**
```
npx vitest run tests/unit/worktree-isolation-hardening.test.ts -t "synchronous"
```

- [ ] **Step 5: Commit**
```bash
git add src/orchestration/WorkerLoop.ts tests/unit/worktree-isolation-hardening.test.ts
git commit -m "fix(worktree): await apply-back so downstream tasks never race the main tree"
```

---

## Task 2: Detect base-divergence conflicts, apply the rest, record (never overwrite, never block)

**Problem:** `applyCommitFiles` overwrites every changed file. Under `worktreeIsolation` (write locks skipped), two tasks can edit the same file; last write wins.

**Design:** Per-file 3-way check against `baseSha`:
- `base` = content at `baseSha`; `ours` = current main-tree content; `theirs` = content at the task's worktree commit.
- `ours === base` → safe, apply `theirs`.
- `ours !== base` (main diverged since base) → **conflict**: do not write, record `{ path, baseSha, taskCommitSha }`. Task still completes normally; the record rides up for the master to merge at W4.

**Files:** `src/git/AgentGitStore.ts`, `src/git/WorktreeIsolator.ts`, `src/orchestration/TaskRunner.ts`, `src/orchestration/WorkerLoop.ts`, `tests/unit/AgentGitStore.test.ts`.

- [ ] **Step 1: Failing test** — in `tests/unit/AgentGitStore.test.ts`:

```typescript
it("applyCommitFilesChecked applies clean files and reports conflicts without overwriting", async () => {
	const base = await store.commitTree([{ relativePath: "a.ts", content: "base-a" }, { relativePath: "s.ts", content: "base-s" }], "base");
	const theirs = await store.commitTree([{ relativePath: "a.ts", content: "their-a" }, { relativePath: "s.ts", content: "their-s" }], "theirs", { parent: base });
	// main: a.ts untouched since base (clean apply); s.ts changed (conflict)
	fs.writeFileSync(path.join(targetRoot, "a.ts"), "base-a", "utf-8");
	fs.writeFileSync(path.join(targetRoot, "s.ts"), "our-s", "utf-8");

	const result = await store.applyCommitFilesChecked(theirs, base, targetRoot);

	expect(result.applied).toEqual(["a.ts"]);
	expect(result.conflicts).toEqual(["s.ts"]);
	expect(fs.readFileSync(path.join(targetRoot, "a.ts"), "utf-8")).toBe("their-a"); // clean applied
	expect(fs.readFileSync(path.join(targetRoot, "s.ts"), "utf-8")).toBe("our-s");   // conflict NOT overwritten
});
```
> `store` / `targetRoot` follow the existing worktree-test setup; if `targetRoot` is absent, add a temp dir in `beforeEach`.

- [ ] **Step 2: Run — confirm failure**
```
npx vitest run tests/unit/AgentGitStore.test.ts -t "applyCommitFilesChecked"
```

- [ ] **Step 3: Implement `applyCommitFilesChecked`** in `src/git/AgentGitStore.ts` (after `applyCommitFiles`):

```typescript
  /**
   * Like {@link applyCommitFiles} but base-aware. A file is a conflict when the
   * main tree's current content diverged from `baseSha` (someone else changed it
   * since the worktree forked). Conflicts are left untouched and reported; clean
   * files are applied. Returns the applied + conflicting relative paths.
   */
  async applyCommitFilesChecked(
    commitSha: string,
    baseSha: string,
    targetRoot: string,
  ): Promise<{ applied: string[]; conflicts: string[] }> {
    const changed = await this.listChangedFiles(baseSha, commitSha);
    const applied: string[] = [];
    const conflicts: string[] = [];

    for (const { path: relativePath, deleted } of changed) {
      const fullPath = path.join(targetRoot, relativePath);
      const baseContent = await this.readFileAtCommit(baseSha, relativePath); // null if absent at base
      let oursContent: string | null;
      try {
        oursContent = await fs.readFile(fullPath, "utf-8");
      } catch {
        oursContent = null;
      }

      if (oursContent !== baseContent) {
        conflicts.push(relativePath); // main diverged since base → defer to master
        continue;
      }

      if (deleted) {
        await fs.unlink(fullPath).catch(() => {});
      } else {
        const content = await this.readFileAtCommit(commitSha, relativePath);
        if (content !== null) {
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, content, "utf-8");
        }
      }
      applied.push(relativePath);
    }
    return { applied, conflicts };
  }
```

- [ ] **Step 4: Run AgentGitStore tests — confirm pass**
```
npx vitest run tests/unit/AgentGitStore.test.ts
```

- [ ] **Step 5: Define `ConflictRecord` + extend `WorktreeResult`.**

In `src/orchestration/TaskRunner.ts`, add and export:
```typescript
/** A worktree file that could not be auto-applied; carried to W4 for an LLM merge. */
export interface ConflictRecord {
	taskId: string;
	/** Repo-relative path of the conflicting file. */
	path: string;
	/** Worktree base commit (the merge base / "base" version). */
	baseSha: string;
	/** The task's worktree commit (the "theirs" version). */
	taskCommitSha: string;
}
```
Add to `TaskResult`:
```typescript
	/** Files the worktree apply-back could not merge cleanly (resolved at W4). */
	mergeConflicts?: ConflictRecord[];
```

In `src/git/WorktreeIsolator.ts`, extend `WorktreeResult` and return SHAs (NOT inline content — the master reads versions from the object store at W4):
```typescript
export interface WorktreeResult {
  sha: string | null;
  changedFiles: string[];
  /** Conflicting files left unapplied: { path, baseSha, taskCommitSha }. */
  conflicts: Array<{ path: string; baseSha: string; taskCommitSha: string }>;
}
```
```typescript
    if (sha === null) {
      return { sha: null, changedFiles: [], conflicts: [] };
    }
    const changed = await this.store.listChangedFiles(baseSha, sha);
    const { conflicts } = await this.store.applyCommitFilesChecked(
      sha,
      baseSha,
      this.store.config.workTree,
    );
    return {
      sha,
      changedFiles: changed.map((f) => f.path),
      conflicts: conflicts.map((p) => ({ path: p, baseSha, taskCommitSha: sha })),
    };
```

- [ ] **Step 6: Attach conflicts to the worker result.**

In `src/orchestration/WorkerLoop.ts`: add `worktreeConflicts?: WorktreeResult["conflicts"]` to `WorkerRunResult`, and after the awaited apply-back set it:
```typescript
		return {
			text: finalContent,
			usage,
			hitStepLimit,
			...(emptyFinalTurn && { emptyFinalTurn }),
			finishReason,
			...(worktreeApply && worktreeApply.conflicts.length > 0 && { worktreeConflicts: worktreeApply.conflicts }),
		};
```
> Confirm the exact fields of the existing `return` in `runTask` and append the spread.

- [ ] **Step 7: Map worker conflicts → `TaskResult.mergeConflicts`.**

In `src/orchestration/ClientAdapters.ts` (`createWorkerExecutor` → the normalisation that builds `WorkerExecutionResult`), carry `worktreeConflicts` through so `TaskRunner` can stamp them onto the `TaskResult` with the `taskId`. In `TaskRunner.runTask`, when assembling the ok result:
```typescript
			...(execution.worktreeConflicts && execution.worktreeConflicts.length > 0 && {
				mergeConflicts: execution.worktreeConflicts.map((c) => ({ taskId: contract.taskId, ...c })),
			}),
```
> Add `worktreeConflicts?` to `WorkerExecutionResult` and to `normalizeWorkerExecution` so it survives the hop.

- [ ] **Step 8: Run worktree + worker + task-runner tests**
```
npx vitest run tests/unit/AgentGitStore.test.ts tests/unit/WorktreeIsolator.test.ts tests/unit/worktree-isolation-hardening.test.ts tests/unit/task-runner.test.ts
```

- [ ] **Step 9: Commit**
```bash
git add src/git/AgentGitStore.ts src/git/WorktreeIsolator.ts src/orchestration/TaskRunner.ts src/orchestration/WorkerLoop.ts src/orchestration/ClientAdapters.ts tests/unit/AgentGitStore.test.ts
git commit -m "feat(worktree): record base-divergence conflicts on apply-back instead of overwriting"
```

---

## Task 3: W4 master-agent LLM 3-way merge of conflicts

**Problem:** Recorded conflicts must be merged. Per the design decision, the master agent (LLM) reads base/ours/theirs and authors the merged file at W4.

**Design:**
- Add `PlannerBridge.resolveConflict(input)` — a pure LLM seam: `{ path, base, ours, theirs } → mergedContent`.
- `MiMoPipeline`, at W4 (after W3.5 accepts), collects `mergeConflicts` across `allResults`. For each, it reads `base = readFileAtCommit(baseSha, path)`, `theirs = readFileAtCommit(taskCommitSha, path)`, `ours = <current projectRoot/path>`, calls `resolveConflict`, and writes the merged content to `projectRoot/path`. Emits a `W4` event per resolved file.

**Files:** `src/orchestration/MiMoPipeline.ts`, `src/orchestration/ClientAdapters.ts` (PlannerBridge impl), the `PlannerBridge` interface (in `MiMoPipeline.ts`).

- [ ] **Step 1: Failing test** — pipeline calls the master to merge a recorded conflict and writes the result. In `tests/unit/worktree-isolation-hardening.test.ts` (or a focused `mimo-pipeline` test), drive `runPipeline` with: a stub planner whose `resolveConflict` returns `"MERGED"`, one task result carrying a `mergeConflicts` entry, and assert `projectRoot/<path>` ends up `"MERGED"`. (If wiring a full `runPipeline` is heavy, test the extracted helper `applyMasterMergedConflicts(conflicts, { store, projectRoot, planner })` directly.)

```typescript
it("W4 writes the master-merged content for a recorded conflict", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w4-merge-")); gitInit(dir);
	const store = await AgentGitStore.resolve(dir);
	const base = await store.commitTree([{ relativePath: "s.ts", content: "base" }], "base");
	const theirs = await store.commitTree([{ relativePath: "s.ts", content: "theirs" }], "theirs", { parent: base });
	fs.writeFileSync(path.join(dir, "s.ts"), "ours", "utf-8");

	const planner = { resolveConflict: async (_i: unknown) => "MERGED" } as unknown as import("../../src/orchestration/MiMoPipeline.js").PlannerBridge;
	const { applyMasterMergedConflicts } = await import("../../src/orchestration/MiMoPipeline.js");
	await applyMasterMergedConflicts(
		[{ taskId: "T1", path: "s.ts", baseSha: base, taskCommitSha: theirs }],
		{ store, projectRoot: dir, planner },
	);

	expect(fs.readFileSync(path.join(dir, "s.ts"), "utf-8")).toBe("MERGED");
	fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run — confirm failure** (`applyMasterMergedConflicts` / `resolveConflict` do not exist)

- [ ] **Step 3: Add `resolveConflict` to the `PlannerBridge` interface** (`src/orchestration/MiMoPipeline.ts`):
```typescript
	/** W4: 3-way merge a single conflicting file; returns the merged content. */
	resolveConflict(input: { path: string; base: string | null; ours: string | null; theirs: string | null }): Promise<string>;
```

- [ ] **Step 4: Export the helper + W4 wiring** (`src/orchestration/MiMoPipeline.ts`):
```typescript
import type { AgentGitStore } from "../git/AgentGitStore.js";
import type { ConflictRecord } from "./TaskRunner.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function applyMasterMergedConflicts(
	conflicts: ConflictRecord[],
	deps: { store: AgentGitStore; projectRoot: string; planner: Pick<PlannerBridge, "resolveConflict"> },
): Promise<Array<{ path: string; ok: boolean }>> {
	const out: Array<{ path: string; ok: boolean }> = [];
	for (const c of conflicts) {
		const base = await deps.store.readFileAtCommit(c.baseSha, c.path);
		const theirs = await deps.store.readFileAtCommit(c.taskCommitSha, c.path);
		const full = path.join(deps.projectRoot, c.path);
		let ours: string | null;
		try { ours = await fs.readFile(full, "utf-8"); } catch { ours = null; }
		try {
			const merged = await deps.planner.resolveConflict({ path: c.path, base, ours, theirs });
			await fs.mkdir(path.dirname(full), { recursive: true });
			await fs.writeFile(full, merged, "utf-8");
			out.push({ path: c.path, ok: true });
		} catch {
			out.push({ path: c.path, ok: false });
		}
	}
	return out;
}
```
Then call it in the W4 phase, after W3.5 accepts and before/at `finalize`:
```typescript
	const conflicts = allResults.flatMap((r) => r.mergeConflicts ?? []);
	if (conflicts.length > 0) {
		emit({ type: "phase_start", phase: "W4", label: "W4 conflict merge" });
		const store = await AgentGitStore.resolve(opts.projectRoot);
		const resolved = await applyMasterMergedConflicts(conflicts, { store, projectRoot: opts.projectRoot, planner: opts.planner });
		emit({ type: "info", phase: "W4", message: `merged ${resolved.filter((r) => r.ok).length}/${conflicts.length} conflicting files` });
	}
```
> Use whatever event shape `PipelineEvent` already supports for an informational W4 message; adapt the `emit(...)` to an existing variant.

- [ ] **Step 5: Implement `resolveConflict` in `createPlannerBridge`** (`src/orchestration/ClientAdapters.ts`) with a master_planner merge prompt:
```typescript
		resolveConflict: async ({ path, base, ours, theirs }) => {
			const sys: ChatMessage = { role: "system", content:
				"You are resolving a 3-way merge conflict. Output ONLY the final merged file content, no fences, no commentary." };
			const user: ChatMessage = { role: "user", content:
				`# File\n${path}\n\n# BASE (common ancestor)\n${base ?? "(absent)"}\n\n# OURS (current main tree)\n${ours ?? "(absent)"}\n\n# THEIRS (task's change)\n${theirs ?? "(absent)"}\n\nProduce the merged file content that preserves both intents.` };
			return collectText(client, [sys, user], max);
		},
```

- [ ] **Step 6: Run — confirm pass**
```
npx vitest run tests/unit/worktree-isolation-hardening.test.ts -t "master-merged"
```

- [ ] **Step 7: Commit**
```bash
git add src/orchestration/MiMoPipeline.ts src/orchestration/ClientAdapters.ts tests/unit/worktree-isolation-hardening.test.ts
git commit -m "feat(w4): master agent performs the 3-way merge of deferred worktree conflicts"
```

---

## Task 4: Relativise snapshots against the effective worktree root

**Problem:** `GitSnapshotManager.snapshot` computes the blob path with `path.relative(this.store.config.workTree, abs)` → junk `../../tmp/...` for worktree files.

**Files:** `src/git/GitSnapshotManager.ts`; test in `tests/unit/worktree-isolation-hardening.test.ts`.

- [ ] **Step 1: Failing test**
```typescript
import { AgentGitStore } from "../../src/git/AgentGitStore.js";
import { GitSnapshotManager } from "../../src/git/GitSnapshotManager.js";

describe("GitSnapshotManager worktree path relativisation", () => {
	let mainDir: string; let wtDir: string;
	beforeEach(() => {
		mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-main-")); gitInit(mainDir);
		wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-wt-"));
		fs.mkdirSync(path.join(wtDir, "src"), { recursive: true });
		fs.writeFileSync(path.join(wtDir, "src", "x.ts"), "v1", "utf-8");
	});
	afterEach(() => { for (const d of [mainDir, wtDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* win */ } } });

	it("stores the path relative to the worktree root, not the main tree", async () => {
		const store = await AgentGitStore.resolve(mainDir);
		const snaps = new GitSnapshotManager(store, "run_test", "t1");
		await snaps.snapshot("src/x.ts", wtDir);
		fs.writeFileSync(path.join(wtDir, "src", "x.ts"), "v2", "utf-8");
		const ok = await snaps.restore("src/x.ts", wtDir);
		expect(ok).toBe(true);
		expect(fs.readFileSync(path.join(wtDir, "src", "x.ts"), "utf-8")).toBe("v1");
		const sha = await store.readRef("refs/minimum/run_test/task/t1");
		expect(await store.readFileAtCommit(sha!, "src/x.ts")).toBe("v1");
	});
});
```

- [ ] **Step 2: Run — confirm failure**
- [ ] **Step 3: Fix `snapshot()`** in `src/git/GitSnapshotManager.ts`:
```typescript
    const root = workingDirectory ?? this.store.config.workTree;
    const relativePath = path.relative(root, abs).replace(/\\/g, "/");
```
- [ ] **Step 4: Run — confirm pass; then run existing snapshot tests for no regression**
```
npx vitest run tests/unit/worktree-isolation-hardening.test.ts -t "relativisation" tests/unit/worker-loop.test.ts
```
- [ ] **Step 5: Commit**
```bash
git add src/git/GitSnapshotManager.ts tests/unit/worktree-isolation-hardening.test.ts
git commit -m "fix(snapshot): relativise snapshot paths against the effective worktree root"
```

---

## Task 5: Run the validator against the effective root

**Problem:** `WorkerLoop.runValidator` passes `workingDirectory: this.projectRoot`, so isolated writes are validated against the main tree.

**Files:** `src/orchestration/WorkerLoop.ts`; test in `tests/unit/worktree-isolation-hardening.test.ts`.

- [ ] **Step 1: Failing test**
```typescript
import type { ICodeValidator } from "../../src/types/validator.js";

it("passes effectiveRoot (worktree), not projectRoot, as the validator workingDirectory", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-val-")); gitInit(dir);
	const seen: Array<string | undefined> = [];
	const validator = { async validate(i: { workingDirectory?: string }) { seen.push(i.workingDirectory); return { passed: true, checks: [] }; } } as unknown as ICodeValidator;
	const loop = new WorkerLoop({ client: oneWriteThenDone(), tools: writingToolHost(), projectRoot: dir, worktreeIsolation: true, validator });
	await loop.runTask({ systemPrompt: "s", userPrompt: "write", persona, contract, maxSteps: 5 });
	expect(seen[0]).not.toBe(dir);
	expect(seen[0]).toContain("minimum-wt-");
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win */ }
});
```

- [ ] **Step 2: Run — confirm failure**
- [ ] **Step 3: Thread `effectiveRoot`** — call site (~668):
```typescript
				const validation = await this.runValidator(name, args, executed, targetPath, effectiveRoot);
```
and signature (~726): add `workingDirectory: string` param, use it instead of `this.projectRoot`.
- [ ] **Step 4: Run — confirm pass**
- [ ] **Step 5: Commit**
```bash
git add src/orchestration/WorkerLoop.ts tests/unit/worktree-isolation-hardening.test.ts
git commit -m "fix(worktree): validate files in the worktree root, not the main project root"
```

---

## Task 6: One run id per pipeline invocation

**Problem:** `WorkerLoop.runTask` mints a fresh `runId` per task → scattered audit refs/checkpoints.

**Design:** Generate one `runId` at `MiMoPipeline` / `DynamicHarness` and thread `DagHarnessOptions.runId → TaskRunnerOptions.runId → WorkerExecutor.run runOpts → WorkerLoop.runTask input`. `runTask` uses `input.runId ?? <fallback>`.

- [ ] **Step 1: Failing test** — two tasks in one harness run share a runId:
```typescript
it("threads one runId from the harness to every task executor call", async () => {
	const seen: Array<string | undefined> = [];
	const executor = { run: async (_c: unknown, _t: unknown, _r: unknown, runOpts?: { runId?: string }) => { seen.push(runOpts?.runId); return `<task_report><status>ok</status></task_report>`; } } as unknown as import("../../src/orchestration/TaskRunner.js").WorkerExecutor;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runid-")); gitInit(dir);
	// build a/b via the mkContract helper copied from dynamic-harness.test.ts
	await new (await import("../../src/orchestration/DynamicHarness.js")).DynamicHarness().runToCompletion([a, b], { projectRoot: dir, executor });
	expect(seen.filter(Boolean)).toHaveLength(2);
	expect(seen[0]).toBe(seen[1]);
	fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run — confirm failure**
- [ ] **Step 3: Add `runId` to the chain:**
  - `TaskRunnerOptions.runId?: string`
  - `WorkerExecutor.run` runOpts gains `runId?: string`; both `executor.run(...)` call sites in `runTask` forward `...(opts.runId && { runId: opts.runId })`
  - `DagHarnessOptions` inherits `runId` from `TaskRunnerOptions`
  - `DynamicHarness.run`: `const runId = options?.runId ?? \`run_${Date.now()}_${Math.random().toString(36).slice(2,9)}\``; pass into `executeTask(contract, options, runId)` → `runTaskWithRetry(contract, { ..., runId })`
  - `MiMoPipeline`: mint one `runId`, pass to `harness.runToCompletion({ ..., runId })`
  - `ClientAdapters` `createWorkerExecutor`: forward `...(runOpts?.runId && { runId: runOpts.runId })` into `workerLoop.runTask`
  - `WorkerLoop`: `WorkerRunInput.runId?: string`; `const runId = input.runId ?? <fallback>`
- [ ] **Step 4: Run — confirm pass + orchestration regression**
```
npx vitest run tests/unit/worktree-isolation-hardening.test.ts tests/unit/dynamic-harness.test.ts tests/unit/task-runner.test.ts
```
- [ ] **Step 5: Commit**
```bash
git add src/orchestration/DagHarness.ts src/orchestration/DynamicHarness.ts src/orchestration/MiMoPipeline.ts src/orchestration/TaskRunner.ts src/orchestration/ClientAdapters.ts src/orchestration/WorkerLoop.ts tests/unit/worktree-isolation-hardening.test.ts
git commit -m "feat(audit): thread one pipeline-wide runId through harness → tasks"
```

---

## Task 7: Binary-safe apply-back (Buffer write + OID conflict detection)

**Problem:** `readFileAtCommit` decodes blobs as utf-8 and apply-back writes with `"utf-8"`, so binary files (images, wasm, fonts) are corrupted on the read→write round-trip. Conflict detection also compares decoded strings.

**Design:**
- Read blobs as raw `Buffer` and write them with no encoding → byte-accurate.
- Detect conflicts by comparing **blob OIDs** (`git rev-parse <sha>:<path>` vs `git hash-object <file>`) instead of decoded content — binary-safe and avoids loading large files as strings.
- Binary *conflicts* cannot be LLM-merged: at W4, skip `resolveConflict` for binary files, keep `ours`, and emit a `binary_conflict` notice so the alternate (`taskCommitSha:path`) can be reviewed — never silently pick a side.

**Files:** `src/git/AgentGitStore.ts`, `src/orchestration/MiMoPipeline.ts` (W4 routing), `tests/unit/AgentGitStore.test.ts`.

- [ ] **Step 1: Failing test** — a binary file round-trips byte-exact, and a clean binary applies. In `tests/unit/AgentGitStore.test.ts`:

```typescript
it("applyCommitFilesChecked preserves binary bytes and detects binary conflicts by OID", async () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe]); // has null + high bytes
	// commit a binary blob via a real worktree commit so git stores raw bytes
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "bin-wt-"));
	execFileSync("git", ["worktree", "add", "--detach", wt, "HEAD"], { cwd: targetRoot, stdio: "ignore" });
	fs.writeFileSync(path.join(wt, "img.bin"), png);
	const sha = await store.captureWorktreeChanges(wt, "add binary");
	const base = await store.readRef("HEAD"); // img.bin absent at base

	const result = await store.applyCommitFilesChecked(sha!, base!, targetRoot);

	expect(result.applied).toContain("img.bin");
	expect(fs.readFileSync(path.join(targetRoot, "img.bin"))).toEqual(png); // exact bytes
	execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: targetRoot, stdio: "ignore" });
});
```
> `targetRoot` is a git-initialised temp dir with at least one commit (HEAD). Reuse the existing worktree-test setup.

- [ ] **Step 2: Run — confirm failure** (file differs: utf-8 round-trip mangled the bytes)
```
npx vitest run tests/unit/AgentGitStore.test.ts -t "preserves binary bytes"
```

- [ ] **Step 3: Add binary-safe primitives** to `src/git/AgentGitStore.ts`:

```typescript
  /** Raw blob bytes from a commit; null if the path is absent. Binary-safe. */
  async readBlobAtCommit(commitSha: string, relativePath: string): Promise<Buffer | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["show", `${commitSha}:${relativePath}`],
        { cwd: this.config.workTree, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      );
      return stdout as unknown as Buffer;
    } catch {
      return null;
    }
  }

  /** Blob OID for a path at a commit; null if absent. */
  async blobOidAtCommit(commitSha: string, relativePath: string): Promise<string | null> {
    try { return await this.git(["rev-parse", `${commitSha}:${relativePath}`]); } catch { return null; }
  }

  /** Blob OID git WOULD assign to an on-disk file; null if missing. */
  async hashFile(absPath: string): Promise<string | null> {
    try { return await this.git(["hash-object", absPath]); } catch { return null; }
  }

  /** True if the blob at <commit>:<path> contains a NUL byte in its head (binary). */
  async isBinaryAtCommit(commitSha: string, relativePath: string): Promise<boolean> {
    const buf = await this.readBlobAtCommit(commitSha, relativePath);
    if (buf === null) return false;
    return buf.subarray(0, 8000).includes(0);
  }
```

- [ ] **Step 4: Rewrite `applyCommitFilesChecked` to be byte-accurate (OID detect + Buffer write):**

```typescript
  async applyCommitFilesChecked(
    commitSha: string,
    baseSha: string,
    targetRoot: string,
  ): Promise<{ applied: string[]; conflicts: string[] }> {
    const changed = await this.listChangedFiles(baseSha, commitSha);
    const applied: string[] = [];
    const conflicts: string[] = [];

    for (const { path: relativePath, deleted } of changed) {
      const fullPath = path.join(targetRoot, relativePath);
      const baseOid = await this.blobOidAtCommit(baseSha, relativePath); // null if absent at base
      const oursOid = await this.hashFile(fullPath);                     // null if absent in main

      if (oursOid !== baseOid) {
        conflicts.push(relativePath); // main diverged from base → defer
        continue;
      }

      if (deleted) {
        await fs.unlink(fullPath).catch(() => {});
      } else {
        const buf = await this.readBlobAtCommit(commitSha, relativePath);
        if (buf !== null) {
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, buf); // no encoding → binary-safe
        }
      }
      applied.push(relativePath);
    }
    return { applied, conflicts };
  }
```
> This supersedes the string-based version from Task 2 Step 3. The Task 2 conflict-record plumbing is unchanged — only the apply/detect internals become byte-accurate.

- [ ] **Step 5: Run AgentGitStore tests — confirm pass (text + binary)**
```
npx vitest run tests/unit/AgentGitStore.test.ts
```

- [ ] **Step 6: Route binary conflicts away from the LLM at W4.** In `applyMasterMergedConflicts` (`src/orchestration/MiMoPipeline.ts`), guard each conflict:

```typescript
	for (const c of conflicts) {
		if (await deps.store.isBinaryAtCommit(c.taskCommitSha, c.path)) {
			// Binary cannot be 3-way merged by the LLM; keep ours, surface the alternate.
			out.push({ path: c.path, ok: false, binary: true });
			continue;
		}
		const base = await deps.store.readFileAtCommit(c.baseSha, c.path);
		// ...existing text-merge path...
	}
```
Adjust the return type to `Array<{ path: string; ok: boolean; binary?: boolean }>` and emit a `binary_conflict`-style notice for any `binary: true` entry (use an existing `PipelineEvent` info variant).

- [ ] **Step 7: Commit**
```bash
git add src/git/AgentGitStore.ts src/orchestration/MiMoPipeline.ts tests/unit/AgentGitStore.test.ts
git commit -m "feat(worktree): binary-safe apply-back (Buffer write + OID conflict detection) and binary-conflict routing"
```

---

## Task 8: Final verification

- [ ] **Step 1:** `npx tsc --noEmit` → zero errors.
- [ ] **Step 2:** `npx vitest run tests/unit/AgentGitStore.test.ts tests/unit/WorktreeIsolator.test.ts tests/unit/worktree-isolation-hardening.test.ts tests/unit/dynamic-harness.test.ts tests/unit/worker-loop.test.ts tests/unit/mimo-pipeline.test.ts`
- [ ] **Step 3:** `npx vitest run` → failure count ≤ pre-plan baseline; any *new* failure is a regression to fix.
- [ ] **Step 4:** Commit any cleanup.

---

## What this plan delivers

| Issue | Before | After |
|-------|--------|-------|
| 1 | apply-back races downstream unlock | `runTask` awaits non-conflicting apply-back before returning |
| 2 | last-write-wins on same file | base-divergence conflicts recorded (not overwritten, not blocked) |
| 3 | conflicts unhandled | **master agent LLM 3-way merges them at W4** and writes the result |
| 4 | snapshot paths escape to `../../tmp/...` | relativised to the worktree root |
| 5 | validator checks the main tree | validator checks the worktree (`effectiveRoot`) |
| 6 | runId per task → scattered audit | one runId per pipeline invocation |
| 7 | binary apply-back corrupts bytes | Buffer write + OID conflict detect; binary conflicts routed away from the LLM |

**Deliberately out of scope:** cross-wave read-after-write via worktree chaining — downstream isolated tasks still fork from main `HEAD`, so they do not see upstream output inside their own worktree. Tracked in the follow-up plan `docs/superpowers/plans/2026-06-10-worktree-chaining-readafterwrite.md` (a run-level "integrated" ref that worktrees fork from and that advances on each apply-back).
