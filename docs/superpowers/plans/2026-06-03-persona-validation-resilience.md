# W0 Persona Validation Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate W0 `pipeline_error` from master_planner persona漂移 by (1) injecting authoritative persona list into master prompt from `listPersonaIds()`, (2) normalizing case/dash in `TaskCompiler`, (3) adding a one-shot retry with feedback in `MiMoPipeline`.

**Architecture:** Three coordinated changes share PersonaRegistry as single source of truth. Compiler normalizes surface forms (`Code-Executor` → `code_executor`) but rejects synonyms (`developer`). When normalized value still fails, pipeline retries once with the compiler error injected as planner feedback. New `compile_retry` event is emitted independently so UI does not misreport as fatal.

**Tech Stack:** TypeScript, Vitest 2.x, Node ESM. Existing test pattern: `tests/unit/<feature>.test.ts`, imports `../../src/orchestration/index.js`.

**Spec:** `docs/superpowers/specs/2026-06-03-persona-validation-resilience-design.md`

---

## File Structure

**Created:**
- `tests/unit/persona-normalize.test.ts` — unit tests for compiler normalization (added cases live in existing `task-compiler.test.ts`; this file is only created if normalization helper is exported separately — see Task 3 note).

**Modified:**
- `src/orchestration/TaskCompiler.ts` — add `normalizePersona`, integrate into `validateTask`, enrich error message.
- `src/personas/PersonaRegistry.ts` — `buildMasterPrompt()` injects authoritative persona list.
- `src/personas/prompts/master-planner.md` — add `runtime_debug` and `docs` to DAG few-shot.
- `src/orchestration/MiMoPipeline.ts` — extend `PlannerBridge.compile` signature with optional `feedback`, add `compile_retry` event variant, one-shot retry around W0 `compileCoarse`.
- `src/orchestration/ClientAdapters.ts` — implement the new optional `feedback` parameter in the planner bridge's `compile`.
- `tests/unit/task-compiler.test.ts` — add 7 normalization / rejection cases.
- `tests/unit/mimo-pipeline.test.ts` — add 2 cases for W0 retry success and double-fail.

---

## Task 1: TaskCompiler normalization + richer error

**Files:**
- Modify: `src/orchestration/TaskCompiler.ts:91-118`
- Test: `tests/unit/task-compiler.test.ts`

- [ ] **Step 1: Write failing tests for normalization and improved error**

Append to `tests/unit/task-compiler.test.ts` inside the existing `describe("compileCoarse", ...)` block:

```typescript
	it("normalizes case for persona", () => {
		const dag = `
<task_dag>
{ "epic": "e", "phases": [ { "id": "P0", "name": "p", "tasks": [
  { "id": "T0-1", "persona": "Vision", "objective": "x",
    "parallelGroup": "g", "dependsOn": [], "needsRefine": false } ] } ] }
</task_dag>`;
		const r = compileCoarse(dag);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.dag.phases[0]!.tasks[0]!.personaId).toBe("vision");
	});

	it("normalizes dashes to underscores for persona", () => {
		const dag = `
<task_dag>
{ "epic": "e", "phases": [ { "id": "P0", "name": "p", "tasks": [
  { "id": "T0-1", "persona": "code-executor", "objective": "x",
    "parallelGroup": "g", "dependsOn": [], "needsRefine": false } ] } ] }
</task_dag>`;
		const r = compileCoarse(dag);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.dag.phases[0]!.tasks[0]!.personaId).toBe("code_executor");
	});

	it("normalizes combined case + dash + whitespace", () => {
		const dag = `
<task_dag>
{ "epic": "e", "phases": [ { "id": "P0", "name": "p", "tasks": [
  { "id": "T0-1", "persona": "  Code-Executor  ", "objective": "x",
    "parallelGroup": "g", "dependsOn": [], "needsRefine": false } ] } ] }
</task_dag>`;
		const r = compileCoarse(dag);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.dag.phases[0]!.tasks[0]!.personaId).toBe("code_executor");
	});

	it("rejects synonyms with original value in error", () => {
		const dag = `
<task_dag>
{ "epic": "e", "phases": [ { "id": "P0", "name": "p", "tasks": [
  { "id": "T0-1", "persona": "developer", "objective": "x",
    "parallelGroup": "g", "dependsOn": [], "needsRefine": false } ] } ] }
</task_dag>`;
		const r = compileCoarse(dag);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toMatch(/persona must be one of/);
			expect(r.error).toMatch(/got "developer"/);
		}
	});

	it("rejects mission_checker (W3.5 inline role)", () => {
		const dag = `
<task_dag>
{ "epic": "e", "phases": [ { "id": "P0", "name": "p", "tasks": [
  { "id": "T0-1", "persona": "mission_checker", "objective": "x",
    "parallelGroup": "g", "dependsOn": [], "needsRefine": false } ] } ] }
</task_dag>`;
		const r = compileCoarse(dag);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/got "mission_checker"/);
	});

	it("rejects non-string persona with informative error", () => {
		const dag = `
<task_dag>
{ "epic": "e", "phases": [ { "id": "P0", "name": "p", "tasks": [
  { "id": "T0-1", "persona": 123, "objective": "x",
    "parallelGroup": "g", "dependsOn": [], "needsRefine": false } ] } ] }
</task_dag>`;
		const r = compileCoarse(dag);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/persona must be one of/);
	});

	it("accepts role alias field with normalization", () => {
		const dag = `
<task_dag>
{ "epic": "e", "phases": [ { "id": "P0", "name": "p", "tasks": [
  { "id": "T0-1", "role": "Repo-Scout", "objective": "x",
    "parallelGroup": "g", "dependsOn": [], "needsRefine": false } ] } ] }
</task_dag>`;
		const r = compileCoarse(dag);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.dag.phases[0]!.tasks[0]!.personaId).toBe("repo_scout");
	});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/task-compiler.test.ts`
Expected: 7 new tests FAIL (5 rejections by current validator, 2 strict-match assertions on `personaId` not yet normalized).

- [ ] **Step 3: Implement normalization in TaskCompiler**

In `src/orchestration/TaskCompiler.ts`, add helper above `validateTask` (around line 90):

```typescript
/** Normalize surface variations the LLM commonly emits. Strict semantics only:
 * we accept case + dash differences but reject synonyms.  */
function normalizePersona(s: string): string {
	return s.trim().toLowerCase().replace(/-/g, "_");
}
```

Replace lines 98-109 in `validateTask`:

```typescript
	const id = raw.id;
	const rawPersona = raw.persona ?? raw.role;
	const persona =
		typeof rawPersona === "string" ? normalizePersona(rawPersona) : undefined;
	const objective = raw.objective;
	const parallelGroup = raw.parallelGroup ?? raw.parallel_group;
	const dependsOn = raw.dependsOn ?? raw.depends_on ?? [];
	const needsRefine = raw.needsRefine ?? raw.needs_refine ?? false;
	const allowedGlobs = raw.allowedGlobs ?? raw.allowed_globs ?? undefined;

	if (typeof id !== "string" || !id)
		return { ok: false, error: `${prefix}.id required` };
	if (!persona || !VALID_PERSONA_IDS.has(persona as PersonaId))
		return {
			ok: false,
			error: `${prefix}.persona must be one of ${[...VALID_PERSONA_IDS].join(",")} (got ${JSON.stringify(rawPersona)})`,
		};
```

Then in the success branch (around line 123) ensure the normalized value is used:

```typescript
			personaId: persona as PersonaId,
```

(The variable name already changed to `persona` — no further edit needed there; just confirm the assignment uses the normalized form.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/task-compiler.test.ts`
Expected: all `compileCoarse` tests PASS, including the 7 new ones. Existing tests unchanged.

- [ ] **Step 5: Run full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS for entire suite.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/TaskCompiler.ts tests/unit/task-compiler.test.ts
git commit -m "fix(orchestration): normalize persona case/dash and enrich validator error

W0 compile previously failed hard on cosmetic variants like 'Code-Executor'.
Add lossless normalization (trim + lowercase + dash->underscore), keep
strict rejection for true synonyms, and include the original value in the
error message for diagnosis."
```

---

## Task 2: Master prompt injects authoritative persona list

**Files:**
- Modify: `src/personas/PersonaRegistry.ts:44-48` (`buildMasterPrompt`)
- Modify: `src/personas/prompts/master-planner.md`
- Test: `tests/unit/personas.test.ts` (extend)

- [ ] **Step 1: Write failing test that master prompt contains all 10 persona ids and the boundary clause**

Append to `tests/unit/personas.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { getPersona, listPersonaIds } from "../../src/personas/PersonaRegistry.js";

describe("master_planner prompt", () => {
	it("contains every registered persona id as an enumerated valid id", () => {
		const sys = getPersona("master_planner").systemPrompt;
		for (const id of listPersonaIds()) {
			expect(sys).toContain(id);
		}
	});

	it("explicitly forbids mission_checker as a coarse persona", () => {
		const sys = getPersona("master_planner").systemPrompt;
		expect(sys).toMatch(/mission_checker/i);
		expect(sys.toLowerCase()).toMatch(/must not appear|forbid|not.*coarse/);
	});

	it("declares persona ids must be exact lowercase underscore", () => {
		const sys = getPersona("master_planner").systemPrompt;
		expect(sys.toLowerCase()).toMatch(/exact|lowercase|underscore/);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/personas.test.ts`
Expected: 3 new tests FAIL (master prompt does not currently enumerate `runtime_debug` / `docs` nor forbid `mission_checker`).

- [ ] **Step 3: Modify `buildMasterPrompt` to inject the authoritative list**

Replace the body of `buildMasterPrompt` in `src/personas/PersonaRegistry.ts:44-48`:

```typescript
function buildMasterPrompt(): string {
	const role = loadPrompt("master-planner.md");
	const skills = renderInlineSkillsForPersona("master_planner");
	const validIds = buildValidPersonaIdsBlock();
	const parts = [role.trimEnd(), validIds];
	if (skills) parts.push(skills);
	return parts.join("\n\n");
}

function buildValidPersonaIdsBlock(): string {
	const ids = [
		"master_planner",
		"vision",
		"repo_scout",
		"context_builder",
		"code_executor",
		"test_writer",
		"test_runner",
		"runtime_debug",
		"reviewer",
		"docs",
	];
	const lines = ids.map((i) => `- ${i}`).join("\n");
	return [
		"## Valid Persona IDs",
		"",
		"Use EXACTLY one of these strings (lowercase, underscore-separated) for any",
		"`persona` field in <task_dag> or <refine>:",
		"",
		lines,
		"",
		'Do NOT use synonyms (e.g. "developer", "tester", "qa") or alternate casings',
		'(e.g. "Code_Executor", "code-executor"). `mission_checker` is a W3.5 inline',
		"role and MUST NOT appear as a coarse DAG persona. Any other value is",
		"rejected by the compiler and aborts the run.",
	].join("\n");
}
```

Note: the hardcoded `ids` array mirrors the registry. Keeping a literal list (rather than calling `listPersonaIds()`) avoids a circular call inside `buildPersonas()` which is invoked at module load. The `personas.test.ts` test asserts equality with `listPersonaIds()`, catching any future drift.

- [ ] **Step 4: Extend master-planner.md DAG few-shot with `runtime_debug` and `docs`**

In `src/personas/prompts/master-planner.md`, replace the DAG example block (lines 38-62) so it includes `runtime_debug` and `docs` rows. Use this exact replacement:

````markdown
```
<task_dag>
{
  "epic": "image_upload_and_preview",
  "phases": [
    { "id": "P0", "name": "perception",
      "tasks": [
        { "id": "T0-1", "persona": "vision",     "objective": "...",
          "needs_refine": false, "parallelGroup": "perception" },
        { "id": "T0-2", "persona": "repo_scout", "objective": "...",
          "needs_refine": false, "parallelGroup": "perception" }
      ]
    },
    { "id": "P2", "name": "implementation",
      "tasks": [
        { "id": "T2-1", "persona": "code_executor", "objective": "...",
          "allowedGlobs": ["TBD-after-refine"],
          "needs_refine": true, "parallelGroup": "backend",
          "dependsOn": ["T0-1","T0-2"] }
      ]
    },
    { "id": "P3", "name": "validation_and_docs",
      "tasks": [
        { "id": "T3-1", "persona": "runtime_debug", "objective": "trace any failing tests to root cause",
          "needs_refine": true, "parallelGroup": "diagnostics",
          "dependsOn": ["T2-1"] },
        { "id": "T3-2", "persona": "docs", "objective": "update README upload section",
          "needs_refine": true, "parallelGroup": "docs",
          "dependsOn": ["T2-1"] }
      ]
    }
  ]
}
</task_dag>
```
````

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/personas.test.ts`
Expected: 3 new tests PASS.

Run: `npx vitest run`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/personas/PersonaRegistry.ts src/personas/prompts/master-planner.md tests/unit/personas.test.ts
git commit -m "feat(personas): inject authoritative persona id list into master prompt

Adds an explicit 'Valid Persona IDs' block to master_planner system prompt
listing all 10 registry ids and forbidding synonyms / alternate casings /
mission_checker. Extends DAG few-shot with runtime_debug and docs so the
model sees the full set."
```

---

## Task 3: PlannerBridge.compile gains optional feedback parameter

**Files:**
- Modify: `src/orchestration/MiMoPipeline.ts:72-85` (PlannerBridge interface)
- Modify: `src/orchestration/ClientAdapters.ts:80-91` (concrete compile)

- [ ] **Step 1: Extend the interface**

In `src/orchestration/MiMoPipeline.ts:73-74`, change:

```typescript
	/** W0: returns master output containing a <task_dag> block. */
	compile(userRequest: string, memoryPrefix: string): Promise<string>;
```

to:

```typescript
	/**
	 * W0: returns master output containing a <task_dag> block.
	 * `feedback` is optional retry context — when present, the implementation
	 * MUST surface it to the LLM as an additional user message so the model
	 * can self-correct (e.g. compiler validation error from a prior attempt).
	 */
	compile(userRequest: string, memoryPrefix: string, feedback?: string): Promise<string>;
```

- [ ] **Step 2: Implement the parameter in the concrete adapter**

In `src/orchestration/ClientAdapters.ts:80-91`, replace:

```typescript
		compile: async (userRequest, memoryPrefix) =>
			collectText(
				client,
				[
					await sys(userRequest),
					{
						role: "user",
						content: `${memoryPrefix}\n\n# User Request\n${userRequest}\n\nCompile the coarse task DAG now. Output a single <task_dag> block.`,
					},
				],
				max,
			),
```

with:

```typescript
		compile: async (userRequest, memoryPrefix, feedback) => {
			const messages: ChatMessage[] = [
				await sys(userRequest),
				{
					role: "user",
					content: `${memoryPrefix}\n\n# User Request\n${userRequest}\n\nCompile the coarse task DAG now. Output a single <task_dag> block.`,
				},
			];
			if (feedback) {
				messages.push({
					role: "user",
					content: `# Compiler Feedback (previous attempt failed)\n${feedback}\n\nRe-emit the ENTIRE <task_dag> block using only the allowed persona ids.`,
				});
			}
			return collectText(client, messages, max);
		},
```

- [ ] **Step 3: Run full suite to verify no regression**

Run: `npx vitest run`
Expected: all PASS. (Existing call sites pass two args; new optional third is backward compatible.)

- [ ] **Step 4: Commit**

```bash
git add src/orchestration/MiMoPipeline.ts src/orchestration/ClientAdapters.ts
git commit -m "feat(orchestration): PlannerBridge.compile accepts optional feedback

Optional third parameter is appended as an extra user message to the
master_planner conversation, enabling one-shot self-correction when W0
compile validation fails. Backward compatible (default undefined)."
```

---

## Task 4: MiMoPipeline W0 one-shot retry with `compile_retry` event

**Files:**
- Modify: `src/orchestration/MiMoPipeline.ts:61-69` (event union)
- Modify: `src/orchestration/MiMoPipeline.ts:126-136` (W0 compile block)
- Test: `tests/unit/mimo-pipeline.test.ts`

- [ ] **Step 1: Write failing tests for retry success and double-fail**

Append to `tests/unit/mimo-pipeline.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { runPipeline, type PipelineEvent, type PlannerBridge } from "../../src/orchestration/MiMoPipeline.js";

function validDagText(): string {
	return `<task_dag>
{ "epic": "e", "phases": [ { "id": "P0", "name": "p", "tasks": [
  { "id": "T0-1", "persona": "vision", "objective": "x",
    "parallelGroup": "g", "dependsOn": [], "needsRefine": false } ] } ] }
</task_dag>`;
}

function invalidDagText(): string {
	return `<task_dag>
{ "epic": "e", "phases": [ { "id": "P0", "name": "p", "tasks": [
  { "id": "T0-1", "persona": "developer", "objective": "x",
    "parallelGroup": "g", "dependsOn": [], "needsRefine": false } ] } ] }
</task_dag>`;
}

function mkPlanner(outputs: string[]): PlannerBridge {
	const compile = vi.fn(async (_r: string, _m: string, _f?: string) => outputs.shift() ?? "");
	return {
		compile,
		refine: vi.fn(async () => "<refine>{\"tasks\":[]}</refine>"),
		checkMission: vi.fn(async () => "ok"),
		finalize: vi.fn(async () => "<finalize>{\"patch_merge_plan\":[],\"memory_decisions\":[]}</finalize>"),
	};
}

describe("MiMoPipeline W0 compile retry", () => {
	it("retries once and succeeds when planner self-corrects", async () => {
		const events: PipelineEvent[] = [];
		const planner = mkPlanner([invalidDagText(), validDagText()]);
		// runPipeline needs a minimal executor + projectRoot — use existing test helpers.
		// (Test scaffolding TBD by the engineer based on existing mimo-pipeline.test.ts
		// helpers; assertions below are the load-bearing checks.)
		const result = await runMinimalPipeline(planner, (e) => events.push(e));
		const compileCalls = (planner.compile as ReturnType<typeof vi.fn>).mock.calls;
		expect(compileCalls.length).toBe(2);
		expect(compileCalls[1]![2]).toMatch(/persona must be one of/);
		expect(events.some((e) => e.type === "compile_retry")).toBe(true);
		expect(events.some((e) => e.type === "pipeline_error")).toBe(false);
		expect(result.ok).toBe(true);
	});

	it("fails after two compile errors with combined error message", async () => {
		const events: PipelineEvent[] = [];
		const planner = mkPlanner([invalidDagText(), invalidDagText()]);
		const result = await runMinimalPipeline(planner, (e) => events.push(e));
		expect((planner.compile as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
		const errEvent = events.find((e) => e.type === "pipeline_error");
		expect(errEvent).toBeDefined();
		if (errEvent && errEvent.type === "pipeline_error") {
			expect(errEvent.error).toMatch(/twice/);
			expect(errEvent.error).toMatch(/first:/);
			expect(errEvent.error).toMatch(/retry:/);
		}
		expect(result.ok).toBe(false);
	});
});
```

**Note for implementer:** `runMinimalPipeline` is a thin test wrapper added at the top of this same test file. First read the existing `tests/unit/mimo-pipeline.test.ts` to reuse any in-file helpers it already declares (executor mock + projectRoot fixture). If no equivalent exists, use this concrete inline version verbatim:

```typescript
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { TaskResult, WorkerExecutor } from "../../src/orchestration/index.js";

async function runMinimalPipeline(
	planner: PlannerBridge,
	onEvent: (e: PipelineEvent) => void,
) {
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-w0-"));
	const executor: WorkerExecutor = {
		async run() {
			const result: TaskResult = {
				taskId: "T0-1",
				personaId: "vision",
				status: "ok",
				report: { kind: "vision_report", findings: [] } as never,
				artifacts: [],
			};
			return result;
		},
	};
	return runPipeline("test request", { projectRoot, planner, executor, onEvent });
}
```

If the existing test file already exports / declares helpers like these, prefer them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/mimo-pipeline.test.ts -t "W0 compile retry"`
Expected: both new tests FAIL — current code emits `pipeline_error` on first failure with no retry, and no `compile_retry` event type exists.

- [ ] **Step 3: Add `compile_retry` to the event union**

In `src/orchestration/MiMoPipeline.ts:61-69`, replace the `PipelineEvent` union:

```typescript
export type PipelineEvent =
	| { type: "phase_start"; phase: PipelinePhase; label: string }
	| { type: "memory_loaded"; includedKeys: string[]; approxTokens: number; truncated: boolean }
	| { type: "dag_compiled"; epicId: string; taskCount: number }
	| { type: "compile_retry"; phase: "W0"; attempt: 1; error: string }
	| { type: "wave"; event: WaveEvent }
	| { type: "refine_done"; contractCount: number; errorCount: number }
	| { type: "finalize_done"; report: FinalizeReport }
	| { type: "pipeline_complete"; results: TaskResult[] }
	| { type: "pipeline_error"; phase: PipelinePhase; error: string };
```

- [ ] **Step 4: Implement the one-shot retry in W0**

In `src/orchestration/MiMoPipeline.ts:126-136`, replace:

```typescript
	let compiledText: string;
	try {
		compiledText = await opts.planner.compile(userRequest, memory.text);
	} catch (e) {
		return fail(emit, "W0", e);
	}
	const compiled = compileCoarse(compiledText);
	if (!compiled.ok) {
		emit({ type: "pipeline_error", phase: "W0", error: compiled.error });
		return { ok: false, results: [], error: compiled.error };
	}
	const dag = compiled.dag;
```

with:

```typescript
	let compiledText: string;
	let compiled: ReturnType<typeof compileCoarse>;
	let firstError: string | undefined;
	try {
		compiledText = await opts.planner.compile(userRequest, memory.text);
	} catch (e) {
		return fail(emit, "W0", e);
	}
	compiled = compileCoarse(compiledText);
	if (!compiled.ok) {
		firstError = compiled.error;
		emit({ type: "compile_retry", phase: "W0", attempt: 1, error: firstError });
		try {
			compiledText = await opts.planner.compile(userRequest, memory.text, firstError);
		} catch (e) {
			return fail(emit, "W0", e);
		}
		compiled = compileCoarse(compiledText);
		if (!compiled.ok) {
			const combined = `W0 compile failed twice; first: ${firstError}; retry: ${compiled.error}`;
			emit({ type: "pipeline_error", phase: "W0", error: combined });
			return { ok: false, results: [], error: combined };
		}
	}
	const dag = compiled.dag;
```

- [ ] **Step 5: Run new tests to verify they pass**

Run: `npx vitest run tests/unit/mimo-pipeline.test.ts -t "W0 compile retry"`
Expected: both PASS.

- [ ] **Step 6: Run full suite**

Run: `npx vitest run`
Expected: all PASS. Pay particular attention to any other consumer of `PipelineEvent` that does exhaustive switching — TypeScript will surface them at compile.

If TypeScript flags unhandled `compile_retry` in switch statements (e.g. in TUI event handler), add a no-op branch there that just renders a soft warning (e.g. `console.warn` or a status-line update). Do NOT change UI styling extensively — leave a brief comment `// soft warning: planner self-corrected after compiler feedback`.

- [ ] **Step 7: Commit**

```bash
git add src/orchestration/MiMoPipeline.ts tests/unit/mimo-pipeline.test.ts
git commit -m "feat(orchestration): one-shot W0 compile retry with feedback

When master_planner emits an invalid <task_dag> (e.g. unknown persona id
after normalization), pipeline now retries compile once with the validator
error injected as feedback, emitting compile_retry instead of failing
immediately. Two consecutive failures terminate with a combined error."
```

If Step 6 required edits to a switch handler:

```bash
git add <handler-file>
git commit -m "chore(tui): handle compile_retry event in switch (soft warning)"
```

---

## Task 5: Mark spec as implemented

**Files:**
- Modify: `docs/superpowers/specs/2026-06-03-persona-validation-resilience-design.md`

Runtime prompt content is already covered by the unit assertions added in Task 2 Step 1, so no extra manual smoke is required.

- [ ] **Step 1: Update spec status line**

Open the spec and replace:

```
- 状态：已批准，待实施
```

with:

```
- 状态：已实施 + 验证通过（2026-06-03）
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-06-03-persona-validation-resilience-design.md
git commit -m "docs(specs): mark persona-validation-resilience as implemented"
```

---

## Acceptance Checklist

- [ ] `npx vitest run` is fully green
- [ ] `tests/unit/task-compiler.test.ts` includes 7 new normalization/rejection cases
- [ ] `tests/unit/personas.test.ts` asserts master prompt contains all 10 ids + forbids mission_checker
- [ ] `tests/unit/mimo-pipeline.test.ts` includes both retry-success and double-fail cases
- [ ] Compiler error message for invalid persona contains the original value in quotes
- [ ] No new event types are unhandled (TypeScript exhaustiveness clean)
- [ ] 5 commits land cleanly (one per task, plus the doc update)
