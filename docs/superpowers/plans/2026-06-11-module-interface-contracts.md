# Master-Authored Module Interface Contracts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the master planner freeze the interface between modules that two or more parallel sub-agents implement, so independently-built modules (frontend/backend, backend module ↔ module, algorithm ↔ algorithm) actually compose — in any language minimum supports.

**Architecture:** The master authors a *language-neutral* interface contract (`schema` + `rules` + golden `fixtures`) plus one *binding* per consuming language (the materialized type/interface/struct text). A dedicated `code_executor` scaffold task owns the binding files and writes them; implementation tasks consume (import) them but cannot write them — so "signature is immutable" falls out of the existing `allowedGlobs` / `PathPolicyEnforcer` machinery for free. Conformance is enforced in two tiers keyed to the project's *detected* toolchain: Tier 1 = the existing `postStaticCompile` (free when the language is statically typed), Tier 2 = a mandatory `contract_test` task that exercises real boundary data against the fixtures (the language-universal backbone). The contract is carried as a first-class field on `TaskContract` and `RefinementEntry`, denormalized onto each owner/consumer contract so `ContextPackBuilder` stays a pure function.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest, Biome. No new runtime dependencies. Hand-rolled validation matching the existing `ContractValidator` style (the codebase deliberately avoids zod — see [ContractValidator.ts:6](../../../src/orchestration/ContractValidator.ts)).

---

## Scope

This plan delivers the **structured-passing + plan-audit core** — exactly what the design's own Assumptions called "第一版先做结构化传递和计划审计，不做 AST 级接口签名 diff 校验". Concretely:

1. Data model on `TaskContract` + `RefinementEntry` (language-neutral schema + per-language bindings).
2. `<refine>` parsing of `interfaceContracts`.
3. Denormalization of contracts onto owner + consumer tasks in `refineDag`.
4. Deterministic validation: ownership uniqueness, owner-writes / consumer-cannot-write the binding files, consumer-depends-on-owner.
5. `ContextPackBuilder` renders a high-priority `## Module Interface Contracts` section.
6. Plan-gate: `PlanAuditInput` carries the contracts and a deterministic pre-check flags a plan that edits another owner's binding file.
7. Master / worker prompt updates (W0 scaffold node, W0.5 output, W2 audit, code_executor / test_writer "blocked on interface change").
8. Regression: tasks with no cross-module surface still work unchanged.

**Explicitly deferred to a follow-up plan** (`docs/superpowers/plans/<later>-interface-contract-amendment-loop.md`), because it touches the dynamic scheduler and is separable:

- The **amendment loop**: an implementation task returns `blocked` with a proposed contract delta → master amends `schema`/`bindings` → a `T3.5-` re-scaffold task re-writes the binding files → consumers whose recorded `revision` is stale are invalidated and re-queued. The `revision` and `consumerTaskIds` fields are added now so the data is ready; the *scheduler-side invalidation* is the follow-up.
- AST-level signature diffing / per-language semantic validators (the design defers this too).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/orchestration/TaskContract.ts` | Contract & coarse-DAG types | Add `InterfaceContract`, `InterfaceBinding`, `InterfaceBoundaryKind`; add optional `interfaceContracts` to `TaskContract` |
| `src/orchestration/Refiner.ts` | Parse `<refine>`, assemble contracts | Parse + validate `interfaceContracts` on entries; denormalize onto owner/consumer contracts in `refineDag` |
| `src/orchestration/ContractValidator.ts` | Pre-launch contract validation | Add `findInterfaceContractIssues(contracts)` (pure, multi-contract) |
| `src/memory/governance/ContextPackBuilder.ts` | Per-task bounded context | Render `## Module Interface Contracts` with high priority |
| `src/orchestration/PlanGate.ts` | W2 plan-audit parsing | Add `PlanAuditInput` type + `findInterfacePlanViolations(filesToChange, contract)` |
| `src/orchestration/index.ts` | Barrel exports | Export the new types & functions |
| `src/personas/prompts/master-planner/w0.md` | Coarse-DAG rules | Add rule: emit a scaffold node when splitting a module across parallel tasks |
| `src/personas/prompts/master-planner/w05.md` | Refine output rules | Add `interfaceContracts` output spec |
| `src/personas/prompts/master-planner/w2-plan.md` | Plan-audit checklist | Add interface-ownership audit item |
| `src/personas/prompts/code-executor.md` | Implementer rules | "Implementation editable, interface signature not — return blocked to change it" |
| `src/personas/prompts/test-writer.md` | Test rules | Same blocked rule + contract-test guidance |
| `tests/unit/refiner.test.ts` | Refiner tests | Parsing + denormalization + validation cases |
| `tests/unit/context-pack-builder.test.ts` | Context-pack tests | Rendering + budget-priority cases |
| `tests/unit/plan-gate.test.ts` | Plan-gate tests | Deterministic violation pre-check |
| `tests/unit/task-contract.test.ts` | Validator tests | `findInterfaceContractIssues` cases |

Run all tests with: `npm test` (Vitest). Typecheck with: `npm run typecheck`. A single file: `npx vitest run tests/unit/refiner.test.ts`.

---

## Task 1: Interface-contract types on TaskContract

**Files:**
- Modify: `src/orchestration/TaskContract.ts` (append after `TaskPathPolicy`, around line 114)

- [ ] **Step 1: Add the types**

Append to `src/orchestration/TaskContract.ts`:

```ts
/**
 * The kind of module boundary an InterfaceContract freezes. Chosen by the
 * boundary's shape, not by language syntax:
 *  - function_signature: an in-process call surface (typed langs → Tier 1 compile).
 *  - data_schema: a data shape passed between modules / algorithm stages.
 *  - api_rpc: a cross-process HTTP / RPC surface.
 *  - artifact_handoff: producer writes a file/artifact, consumer reads it.
 */
export type InterfaceBoundaryKind =
	| "function_signature"
	| "data_schema"
	| "api_rpc"
	| "artifact_handoff";

/**
 * One language materialization of a contract. For a same-language boundary
 * (e.g. a TS frontend + TS backend) there is a single binding both sides import.
 * For a polyglot boundary (e.g. a Python algorithm feeding a Go service) there
 * is one binding per side, all sharing the contract's neutral `schema`.
 */
export interface InterfaceBinding {
	/** Language id as reported by repo_scout tech_stack, e.g. "typescript", "python", "go". */
	language: string;
	/**
	 * Repo-relative paths holding this binding. The scaffold (owner) task's
	 * allowedGlobs MUST cover these; every consumer's allowedGlobs MUST NOT —
	 * that is what makes the signature immutable to implementers.
	 */
	files: string[];
	/** Master-authored binding text in this language; the scaffold task writes it verbatim. */
	definition: string;
}

/**
 * A frozen module interface authored by the master in W0.5. It is denormalized
 * onto the owner task and every consumer task so ContextPackBuilder can render
 * it without cross-task lookups.
 */
export interface InterfaceContract {
	/** Unique within the epic, e.g. "IC-todo-api". */
	id: string;
	boundary: InterfaceBoundaryKind;
	/** Language-neutral source of truth (JSON-Schema-ish or IDL text). */
	schema: string;
	/** Semantic guarantees the signature cannot express (status codes, units, null/ordering conventions). */
	rules: string[];
	/** Golden boundary data, language-neutral; both sides test against it. */
	fixtures?: Array<{ name: string; data: unknown }>;
	/** One entry per consuming language/side. Non-empty. */
	bindings: InterfaceBinding[];
	/** The scaffold task allowed to create/modify the binding files. */
	ownerTaskId: string;
	/** Implementation tasks that may import but never write the binding files. */
	consumerTaskIds: string[];
	/** Monotonic; bumped when the master amends the contract (amendment loop, follow-up plan). */
	revision: number;
}
```

- [ ] **Step 2: Add the optional field to TaskContract**

In `src/orchestration/TaskContract.ts`, inside `interface TaskContract`, add after `launchRequirements?` (around line 51):

```ts
	/**
	 * Module interface contracts touching this task. For the owner (scaffold)
	 * task this is the full set it must write; for a consumer task it is the
	 * frozen surface it must implement against and may not rewrite. Denormalized
	 * by refineDag — absent for tasks with no cross-module surface.
	 */
	interfaceContracts?: InterfaceContract[];
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (only additive optional fields; nothing references them yet).

- [ ] **Step 4: Commit**

```bash
git add src/orchestration/TaskContract.ts
git commit -m "feat(contracts): add InterfaceContract types to TaskContract"
```

---

## Task 2: Parse interfaceContracts from the <refine> block

**Files:**
- Modify: `src/orchestration/Refiner.ts` (`RefinementEntry`, `validateEntry`)
- Test: `tests/unit/refiner.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/refiner.test.ts` inside `describe("compileRefinement", ...)`:

```ts
	it("parses interfaceContracts on an entry", () => {
		const text = `<refine>{"tasks":[
			{"taskId":"T1-scaffold","allowedGlobs":["src/shared/api.ts"],
			 "acceptance":["api.ts compiles"],
			 "blockedCondition":"blocked if tech_stack is unavailable or incomplete",
			 "interfaceContracts":[
			   {"id":"IC-todo","boundary":"api_rpc",
			    "schema":"{ Todo: {id,title,done} }",
			    "rules":["empty list returns [] not null"],
			    "fixtures":[{"name":"one","data":{"id":"a","title":"t","done":false}}],
			    "bindings":[{"language":"typescript","files":["src/shared/api.ts"],"definition":"export interface Todo {}"}],
			    "ownerTaskId":"T1-scaffold","consumerTaskIds":["T2-be","T3-fe"],"revision":1}
			 ]}
		]}</refine>`;
		const r = compileRefinement(text);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const e = r.entries.get("T1-scaffold")!;
			expect(e.interfaceContracts).toHaveLength(1);
			const ic = e.interfaceContracts![0]!;
			expect(ic.id).toBe("IC-todo");
			expect(ic.boundary).toBe("api_rpc");
			expect(ic.bindings[0]!.language).toBe("typescript");
			expect(ic.consumerTaskIds).toEqual(["T2-be", "T3-fe"]);
			expect(ic.revision).toBe(1);
		}
	});

	it("rejects an interfaceContract with an unknown boundary", () => {
		const text = `<refine>{"tasks":[
			{"taskId":"T1","allowedGlobs":["src/x.ts"],
			 "interfaceContracts":[
			   {"id":"IC","boundary":"nonsense","schema":"s","rules":[],
			    "bindings":[{"language":"go","files":["x.go"],"definition":"d"}],
			    "ownerTaskId":"T1","consumerTaskIds":[],"revision":1}]}
		]}</refine>`;
		const r = compileRefinement(text);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("boundary");
	});

	it("rejects an interfaceContract with no bindings", () => {
		const text = `<refine>{"tasks":[
			{"taskId":"T1","allowedGlobs":["src/x.ts"],
			 "interfaceContracts":[
			   {"id":"IC","boundary":"data_schema","schema":"s","rules":[],
			    "bindings":[],"ownerTaskId":"T1","consumerTaskIds":[],"revision":1}]}
		]}</refine>`;
		const r = compileRefinement(text);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("bindings");
	});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/refiner.test.ts -t interfaceContract`
Expected: FAIL — `e.interfaceContracts` is `undefined`.

- [ ] **Step 3: Add the field to RefinementEntry**

In `src/orchestration/Refiner.ts`, import the new types (extend the existing import from `./TaskContract.js`):

```ts
import type {
	CoarseDag,
	CoarseTask,
	InterfaceContract,
	LaunchArtifact,
	LaunchRequirement,
	TaskContract,
	TaskInputs,
} from "./TaskContract.js";
```

Add to `interface RefinementEntry` (after `grantedMcpTools?`):

```ts
	/** Module interface contracts the master freezes for this (owner) task's surface. */
	interfaceContracts?: InterfaceContract[];
```

- [ ] **Step 4: Parse + validate in validateEntry**

In `src/orchestration/Refiner.ts`, inside `validateEntry`, before the final `return { ok: true, entry: {...} }`, add:

```ts
	const rawContracts = raw.interfaceContracts ?? raw.interface_contracts;
	let interfaceContracts: InterfaceContract[] | undefined;
	if (rawContracts !== undefined) {
		const ic = validateInterfaceContracts(rawContracts, taskId);
		if (!ic.ok) return { ok: false, error: ic.error };
		interfaceContracts = ic.value;
	}
```

Then add `...(interfaceContracts !== undefined && { interfaceContracts })` to the returned `entry` object literal.

Add this validator function near `validateLaunchRequirements`:

```ts
const BOUNDARY_KINDS = new Set<InterfaceBoundaryKind>([
	"function_signature",
	"data_schema",
	"api_rpc",
	"artifact_handoff",
]);

function validateInterfaceContracts(
	raw: unknown,
	taskId: string,
): { ok: true; value: InterfaceContract[] } | { ok: false; error: string } {
	if (!Array.isArray(raw))
		return { ok: false, error: `refine entry ${taskId}: interfaceContracts must be an array` };
	const out: InterfaceContract[] = [];
	for (const [i, c] of raw.entries()) {
		const where = `refine entry ${taskId}: interfaceContracts[${i}]`;
		if (!isObj(c)) return { ok: false, error: `${where} must be an object` };
		if (typeof c.id !== "string" || !c.id) return { ok: false, error: `${where}.id required` };
		if (typeof c.boundary !== "string" || !BOUNDARY_KINDS.has(c.boundary as InterfaceBoundaryKind))
			return { ok: false, error: `${where}.boundary must be one of ${[...BOUNDARY_KINDS].join(",")}` };
		if (typeof c.schema !== "string" || !c.schema) return { ok: false, error: `${where}.schema required` };
		if (!Array.isArray(c.rules) || !c.rules.every((r) => typeof r === "string"))
			return { ok: false, error: `${where}.rules must be string[]` };
		if (!Array.isArray(c.bindings) || c.bindings.length === 0)
			return { ok: false, error: `${where}.bindings must be a non-empty array` };
		for (const [j, b] of (c.bindings as unknown[]).entries()) {
			if (!isObj(b)) return { ok: false, error: `${where}.bindings[${j}] must be an object` };
			if (typeof b.language !== "string" || !b.language)
				return { ok: false, error: `${where}.bindings[${j}].language required` };
			if (!Array.isArray(b.files) || b.files.length === 0 || !b.files.every((f) => typeof f === "string"))
				return { ok: false, error: `${where}.bindings[${j}].files must be a non-empty string[]` };
			if (typeof b.definition !== "string" || !b.definition)
				return { ok: false, error: `${where}.bindings[${j}].definition required` };
		}
		if (typeof c.ownerTaskId !== "string" || !c.ownerTaskId)
			return { ok: false, error: `${where}.ownerTaskId required` };
		if (!Array.isArray(c.consumerTaskIds) || !c.consumerTaskIds.every((t) => typeof t === "string"))
			return { ok: false, error: `${where}.consumerTaskIds must be string[]` };
		const revision = typeof c.revision === "number" ? c.revision : 1;
		out.push({
			id: c.id,
			boundary: c.boundary as InterfaceBoundaryKind,
			schema: c.schema,
			rules: c.rules as string[],
			...(Array.isArray(c.fixtures) && { fixtures: c.fixtures as InterfaceContract["fixtures"] }),
			bindings: (c.bindings as InterfaceBinding[]).map((b) => ({
				language: b.language,
				files: b.files,
				definition: b.definition,
			})),
			ownerTaskId: c.ownerTaskId,
			consumerTaskIds: c.consumerTaskIds as string[],
			revision,
		});
	}
	return { ok: true, value: out };
}
```

Extend the type import to include `InterfaceBinding` and `InterfaceBoundaryKind`:

```ts
import type {
	CoarseDag,
	CoarseTask,
	InterfaceBinding,
	InterfaceBoundaryKind,
	InterfaceContract,
	LaunchArtifact,
	LaunchRequirement,
	TaskContract,
	TaskInputs,
} from "./TaskContract.js";
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/unit/refiner.test.ts -t interfaceContract`
Expected: PASS (all three cases).

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/Refiner.ts tests/unit/refiner.test.ts
git commit -m "feat(contracts): parse interfaceContracts in <refine> block"
```

---

## Task 3: Denormalize contracts onto owner + consumer tasks

The master emits each `InterfaceContract` once, on the **owner** (scaffold) task's refine entry. `refineDag` must copy it onto the owner contract *and* every `consumerTaskIds` contract so each worker's ContextPack carries the frozen surface.

**Files:**
- Modify: `src/orchestration/Refiner.ts` (`refineDag`)
- Test: `tests/unit/refiner.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/refiner.test.ts` inside `describe("refineDag", ...)` (create the describe block if absent):

```ts
	it("denormalizes interfaceContracts onto owner and consumer contracts", () => {
		const dag: CoarseDag = {
			epicId: "todo",
			phases: [
				{
					id: "P1",
					name: "impl",
					tasks: [
						{ id: "T1-scaffold", personaId: "code_executor", objective: "write shared api contract", parallelGroup: "scaffold", dependsOn: [], needsRefine: true },
						{ id: "T2-be", personaId: "code_executor", objective: "implement backend handlers", parallelGroup: "impl", dependsOn: ["T1-scaffold"], needsRefine: true },
						{ id: "T3-fe", personaId: "code_executor", objective: "implement frontend client", parallelGroup: "impl", dependsOn: ["T1-scaffold"], needsRefine: true },
					],
				},
			],
		};
		const refinement = new Map<string, RefinementEntry>([
			["T1-scaffold", {
				taskId: "T1-scaffold",
				allowedGlobs: ["src/shared/api.ts"],
				acceptance: ["api.ts compiles"],
				nonGoals: ["no business logic"],
				blockedCondition: "blocked if tech_stack is unavailable or incomplete",
				interfaceContracts: [{
					id: "IC-todo", boundary: "api_rpc", schema: "{Todo}", rules: ["[] not null"],
					bindings: [{ language: "typescript", files: ["src/shared/api.ts"], definition: "export interface Todo {}" }],
					ownerTaskId: "T1-scaffold", consumerTaskIds: ["T2-be", "T3-fe"], revision: 1,
				}],
			}],
			["T2-be", { taskId: "T2-be", allowedGlobs: ["src/backend/**"], acceptance: ["handlers"], nonGoals: ["no contract edits"], blockedCondition: "blocked if IC-todo is missing or contradictory" }],
			["T3-fe", { taskId: "T3-fe", allowedGlobs: ["src/frontend/**"], acceptance: ["client"], nonGoals: ["no contract edits"], blockedCondition: "blocked if IC-todo is missing or contradictory" }],
		]);
		const { contracts, errors } = refineDag(dag, { inputs: baseInputs, refinement });
		expect(errors).toEqual([]);
		const byId = new Map(contracts.map((c) => [c.taskId, c]));
		expect(byId.get("T1-scaffold")!.interfaceContracts).toHaveLength(1);
		expect(byId.get("T2-be")!.interfaceContracts![0]!.id).toBe("IC-todo");
		expect(byId.get("T3-fe")!.interfaceContracts![0]!.id).toBe("IC-todo");
	});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/refiner.test.ts -t denormalizes`
Expected: FAIL — `interfaceContracts` is `undefined` on every contract.

- [ ] **Step 3: Implement denormalization**

In `src/orchestration/Refiner.ts`, in `refineDag`, after the loop that builds `contracts` and before the `if (validate)` block, add:

```ts
	distributeInterfaceContracts(contracts, opts.refinement);
```

Add this function below `refineDag`:

```ts
/**
 * Each InterfaceContract is authored once on its owner task's refinement entry.
 * Copy it onto the owner contract and every consumer contract so each worker's
 * ContextPack carries the frozen surface. Pure assignment — validation of
 * ownership/consumer ids happens in ContractValidator.findInterfaceContractIssues.
 */
function distributeInterfaceContracts(
	contracts: TaskContract[],
	refinement: Map<string, RefinementEntry>,
): void {
	const byId = new Map(contracts.map((c) => [c.taskId, c]));
	for (const entry of refinement.values()) {
		for (const ic of entry.interfaceContracts ?? []) {
			const targets = new Set<string>([ic.ownerTaskId, ...ic.consumerTaskIds]);
			for (const taskId of targets) {
				const contract = byId.get(taskId);
				if (!contract) continue; // dangling id — reported by validation
				(contract.interfaceContracts ??= []).push(ic);
			}
		}
	}
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/refiner.test.ts -t denormalizes`
Expected: PASS.

- [ ] **Step 5: Run the full refiner suite (regression)**

Run: `npx vitest run tests/unit/refiner.test.ts`
Expected: PASS — existing tests untouched (the field is optional and only populated when present).

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/Refiner.ts tests/unit/refiner.test.ts
git commit -m "feat(contracts): denormalize interface contracts onto owner+consumer tasks"
```

---

## Task 4: Deterministic interface-contract validation

The strongest guarantees are checkable without an LLM and without AST diffing:
- contract `id` unique across the set;
- `ownerTaskId` and every `consumerTaskIds` exist;
- the owner's `allowedGlobs` cover every binding file (owner can write them);
- no consumer's `allowedGlobs` matches any binding file (consumers cannot rewrite the signature);
- every consumer (transitively) depends on the owner, so the binding files exist before the consumer runs.

**Files:**
- Modify: `src/orchestration/ContractValidator.ts`
- Modify: `src/orchestration/index.ts` (export)
- Test: `tests/unit/task-contract.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/task-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { findInterfaceContractIssues } from "../../src/orchestration/index.js";
import type { InterfaceContract, TaskContract } from "../../src/orchestration/index.js";

function mkContract(over: Partial<TaskContract>): TaskContract {
	return {
		taskId: "T1", phase: "P1", epicId: "e", personaId: "code_executor",
		objective: "implement something concrete",
		inputs: { userGoal: "goal", artifacts: [], constraints: [] },
		pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		acceptance: ["done"], nonGoals: ["nope"], blockedCondition: "blocked if x is missing",
		outputSchema: "task_report", parallelGroup: "g", dependsOn: [],
		grantedSkills: [], grantedMcpTools: [], abortOnConflict: false,
		...over,
	};
}

const ic: InterfaceContract = {
	id: "IC", boundary: "api_rpc", schema: "s", rules: [],
	bindings: [{ language: "typescript", files: ["src/shared/api.ts"], definition: "export {}" }],
	ownerTaskId: "T1-scaffold", consumerTaskIds: ["T2-be"], revision: 1,
};

describe("findInterfaceContractIssues", () => {
	it("passes a well-formed owner/consumer pair", () => {
		const contracts = [
			mkContract({ taskId: "T1-scaffold", parallelGroup: "scaffold", pathPolicy: { allowedGlobs: ["src/shared/api.ts"], forbiddenGlobs: [] }, interfaceContracts: [ic] }),
			mkContract({ taskId: "T2-be", parallelGroup: "impl", dependsOn: ["T1-scaffold"], pathPolicy: { allowedGlobs: ["src/backend/**"], forbiddenGlobs: [] }, interfaceContracts: [ic] }),
		];
		expect(findInterfaceContractIssues(contracts)).toEqual([]);
	});

	it("flags a consumer that can write the binding file", () => {
		const contracts = [
			mkContract({ taskId: "T1-scaffold", pathPolicy: { allowedGlobs: ["src/shared/api.ts"], forbiddenGlobs: [] }, interfaceContracts: [ic] }),
			mkContract({ taskId: "T2-be", dependsOn: ["T1-scaffold"], pathPolicy: { allowedGlobs: ["src/shared/api.ts"], forbiddenGlobs: [] }, interfaceContracts: [ic] }),
		];
		const issues = findInterfaceContractIssues(contracts);
		expect(issues.some((i) => i.includes("T2-be") && i.includes("src/shared/api.ts"))).toBe(true);
	});

	it("flags an owner that cannot write the binding file", () => {
		const contracts = [
			mkContract({ taskId: "T1-scaffold", pathPolicy: { allowedGlobs: ["src/other/**"], forbiddenGlobs: [] }, interfaceContracts: [ic] }),
			mkContract({ taskId: "T2-be", dependsOn: ["T1-scaffold"], pathPolicy: { allowedGlobs: ["src/backend/**"], forbiddenGlobs: [] }, interfaceContracts: [ic] }),
		];
		const issues = findInterfaceContractIssues(contracts);
		expect(issues.some((i) => i.includes("owner") && i.includes("src/shared/api.ts"))).toBe(true);
	});

	it("flags a consumer that does not depend on the owner", () => {
		const contracts = [
			mkContract({ taskId: "T1-scaffold", pathPolicy: { allowedGlobs: ["src/shared/api.ts"], forbiddenGlobs: [] }, interfaceContracts: [ic] }),
			mkContract({ taskId: "T2-be", dependsOn: [], pathPolicy: { allowedGlobs: ["src/backend/**"], forbiddenGlobs: [] }, interfaceContracts: [ic] }),
		];
		const issues = findInterfaceContractIssues(contracts);
		expect(issues.some((i) => i.includes("T2-be") && i.includes("depend"))).toBe(true);
	});

	it("flags a dangling owner id", () => {
		const orphan: InterfaceContract = { ...ic, ownerTaskId: "T9-missing" };
		const contracts = [
			mkContract({ taskId: "T2-be", dependsOn: [], pathPolicy: { allowedGlobs: ["src/backend/**"], forbiddenGlobs: [] }, interfaceContracts: [orphan] }),
		];
		const issues = findInterfaceContractIssues(contracts);
		expect(issues.some((i) => i.includes("T9-missing"))).toBe(true);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/task-contract.test.ts -t findInterfaceContractIssues`
Expected: FAIL — `findInterfaceContractIssues` is not exported.

- [ ] **Step 3: Implement the validator**

In `src/orchestration/ContractValidator.ts`, add the import for `matchGlob` / `normalizeRelPath` at the top:

```ts
import { matchGlob, normalizeRelPath } from "../tools/policy/PathPolicyEnforcer.js";
```

Append this function (and a small reachability helper) at the end of the file, before the final re-export line:

```ts
/**
 * Validate module interface contracts across a contract set. Deduplicates by
 * identity (a contract is denormalized onto owner + consumers, so the same
 * object appears multiple times). Returns a flat error list, empty if clean.
 *
 * Checks, all deterministic and AST-free:
 *  - contract id unique;
 *  - ownerTaskId and consumerTaskIds resolve to tasks in the set;
 *  - owner's allowedGlobs cover every binding file (owner can write them);
 *  - no consumer's allowedGlobs matches any binding file (signature immutable);
 *  - every consumer (transitively) depends on the owner.
 */
export function findInterfaceContractIssues(contracts: TaskContract[]): string[] {
	const errors: string[] = [];
	const byId = new Map(contracts.map((c) => [c.taskId, c]));
	const reaches = buildReachability(contracts);

	const seen = new Map<string, TaskContract["interfaceContracts"][number]>() as Map<string, never>;
	const uniq = new Map<string, NonNullable<TaskContract["interfaceContracts"]>[number]>();
	for (const c of contracts) {
		for (const ic of c.interfaceContracts ?? []) {
			if (!uniq.has(ic.id)) uniq.set(ic.id, ic);
		}
	}
	void seen; // ids are deduplicated above

	for (const ic of uniq.values()) {
		const owner = byId.get(ic.ownerTaskId);
		if (!owner) {
			errors.push(`interface ${ic.id}: ownerTaskId ${ic.ownerTaskId} is not a task in this set`);
		}
		const bindingFiles = ic.bindings.flatMap((b) => b.files.map((f) => normalizeRelPath(f)));

		if (owner) {
			for (const file of bindingFiles) {
				if (!owner.pathPolicy.allowedGlobs.some((g) => matchGlob(file, g))) {
					errors.push(`interface ${ic.id}: owner ${owner.taskId} allowedGlobs must cover binding file ${file}`);
				}
			}
		}

		for (const consumerId of ic.consumerTaskIds) {
			const consumer = byId.get(consumerId);
			if (!consumer) {
				errors.push(`interface ${ic.id}: consumerTaskId ${consumerId} is not a task in this set`);
				continue;
			}
			for (const file of bindingFiles) {
				if (consumer.pathPolicy.allowedGlobs.some((g) => matchGlob(file, g))) {
					errors.push(`interface ${ic.id}: consumer ${consumerId} must not be able to write binding file ${file}`);
				}
			}
			if (owner && consumerId !== owner.taskId && !reaches(consumerId, owner.taskId)) {
				errors.push(`interface ${ic.id}: consumer ${consumerId} must depend (transitively) on owner ${owner.taskId}`);
			}
		}
	}
	return errors;
}

/** Returns a predicate reaches(from, to): does `from` depend transitively on `to`? */
function buildReachability(contracts: TaskContract[]): (from: string, to: string) => boolean {
	const deps = new Map(contracts.map((c) => [c.taskId, c.dependsOn]));
	const memo = new Map<string, Set<string>>();
	function ancestorsOf(id: string): Set<string> {
		const cached = memo.get(id);
		if (cached) return cached;
		const acc = new Set<string>();
		memo.set(id, acc); // guard against cycles
		for (const dep of deps.get(id) ?? []) {
			acc.add(dep);
			for (const a of ancestorsOf(dep)) acc.add(a);
		}
		return acc;
	}
	return (from, to) => ancestorsOf(from).has(to);
}
```

> Note: the `seen`/`void seen` lines above are vestigial — replace the body's dedupe with just the `uniq` map. Final code should keep only the `uniq` loop. (Self-review fixed below in Step 5.)

- [ ] **Step 4: Export from the barrel**

In `src/orchestration/index.ts`, extend the `ContractValidator.js` export block:

```ts
export {
	findDanglingDeps,
	findGlobConflicts,
	findInterfaceContractIssues,
	validateContract,
	type ValidationResult,
} from "./ContractValidator.js";
```

And add `InterfaceContract`, `InterfaceBinding`, `InterfaceBoundaryKind` to the `TaskContract.js` type export block:

```ts
export type {
	CoarseDag,
	CoarsePhase,
	CoarseTask,
	InterfaceBinding,
	InterfaceBoundaryKind,
	InterfaceContract,
	LaunchArtifact,
	LaunchRequirement,
	TaskContract,
	TaskInputs,
	TaskPathPolicy,
} from "./TaskContract.js";
```

- [ ] **Step 5: Clean up the dedupe (remove vestigial lines)**

In `findInterfaceContractIssues`, delete the two lines:

```ts
	const seen = new Map<string, TaskContract["interfaceContracts"][number]>() as Map<string, never>;
```
and
```ts
	void seen; // ids are deduplicated above
```

Keep only the `uniq` map loop. Re-run typecheck after removal.

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run tests/unit/task-contract.test.ts -t findInterfaceContractIssues`
Expected: PASS (all five cases).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Wire into refineDag validation**

In `src/orchestration/Refiner.ts`, inside `refineDag`'s `if (validate)` block, after the `findGlobConflicts` check, add:

```ts
		const interfaceIssues = findInterfaceContractIssues(contracts);
		if (interfaceIssues.length > 0) {
			errors.push({ taskId: "_interface_contract", errors: interfaceIssues });
		}
```

Extend the import from `./ContractValidator.js` at the top of `Refiner.ts`:

```ts
import { findGlobConflicts, findInterfaceContractIssues, validateContract } from "./ContractValidator.js";
```

- [ ] **Step 8: Run refiner + validator suites**

Run: `npx vitest run tests/unit/refiner.test.ts tests/unit/task-contract.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/orchestration/ContractValidator.ts src/orchestration/Refiner.ts src/orchestration/index.ts tests/unit/task-contract.test.ts
git commit -m "feat(contracts): deterministic interface-contract validation in refineDag"
```

---

## Task 5: Render the contracts into the ContextPack

The frozen surface is essential, not optional — it must survive token-budget truncation. Render it right after the head (objective/acceptance/constraints), before Project Memory and Perception Findings. The owner (scaffold) task sees the full schema + all bindings; a consumer sees the schema, the rules, and the binding(s) for the languages it imports.

**Files:**
- Modify: `src/memory/governance/ContextPackBuilder.ts`
- Test: `tests/unit/context-pack-builder.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/context-pack-builder.test.ts`:

```ts
	it("renders module interface contracts for a consumer", () => {
		const contract = mkContract({
			taskId: "T2-be",
			interfaceContracts: [{
				id: "IC-todo", boundary: "api_rpc", schema: "{ Todo: {id,title,done} }",
				rules: ["empty list returns [] not null"],
				bindings: [{ language: "typescript", files: ["src/shared/api.ts"], definition: "export interface Todo {}" }],
				ownerTaskId: "T1-scaffold", consumerTaskIds: ["T2-be"], revision: 1,
			}],
		});
		const pack = buildContextPack({ contract, candidates: [] });
		expect(pack.text).toContain("## Module Interface Contracts");
		expect(pack.text).toContain("IC-todo");
		expect(pack.text).toContain("empty list returns [] not null");
		expect(pack.text).toContain("export interface Todo {}");
		expect(pack.text).toContain("owner: T1-scaffold");
	});

	it("keeps interface contracts even when the budget is tiny", () => {
		const contract = mkContract({
			taskId: "T2-be",
			interfaceContracts: [{
				id: "IC-keep", boundary: "data_schema", schema: "shape", rules: ["r"],
				bindings: [{ language: "python", files: ["shared/contract.py"], definition: "class Todo: ..." }],
				ownerTaskId: "T1", consumerTaskIds: ["T2-be"], revision: 1,
			}],
			inputs: { userGoal: "g", artifacts: [], constraints: [] },
		});
		const candidates = [
			{ sourceTask: "S", persona: "repo_scout", scope: "x", confidence: "high" as const, relatedFiles: [], body: "x".repeat(5000) },
		];
		const pack = buildContextPack({ contract, candidates, maxTokens: 200 });
		expect(pack.text).toContain("IC-keep");
	});
```

> If `mkContract` does not yet exist in this test file, add the same helper used in `tests/unit/task-contract.test.ts` (Task 4, Step 1) at the top of `context-pack-builder.test.ts`, adjusting the import to pull `TaskContract` from `../../src/orchestration/index.js`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/context-pack-builder.test.ts -t "interface contracts"`
Expected: FAIL — no `## Module Interface Contracts` section.

- [ ] **Step 3: Implement the rendering**

In `src/memory/governance/ContextPackBuilder.ts`, inside `buildContextPack`, immediately after `budget.pushAlways(renderHead(contract));` add:

```ts
	// --- Module interface contracts (high priority: essential, not optional) ---
	const contracts = contract.interfaceContracts ?? [];
	if (contracts.length > 0) {
		budget.pushAlways(renderInterfaceContracts(contract.taskId, contracts));
	}
```

Add the renderer below `renderHead`:

```ts
function renderInterfaceContracts(
	taskId: string,
	contracts: NonNullable<TaskContract["interfaceContracts"]>,
): string {
	const lines: string[] = ["\n## Module Interface Contracts\n"];
	lines.push(
		"> Frozen by the master. Implement against these surfaces; you may NOT change a\n" +
			"> binding's signature. If a change is unavoidable, stop and return blocked.\n",
	);
	for (const ic of contracts) {
		const role = ic.ownerTaskId === taskId ? "OWNER (you write the binding files)" : "CONSUMER (import only, do not edit)";
		lines.push(`\n### ${ic.id} — ${ic.boundary} [${role}]\n`);
		lines.push(`owner: ${ic.ownerTaskId} · consumers: ${ic.consumerTaskIds.join(", ") || "—"} · revision: ${ic.revision}\n`);
		lines.push(`\n**Schema (source of truth):**\n\n\`\`\`\n${ic.schema.trim()}\n\`\`\`\n`);
		if (ic.rules.length > 0) {
			lines.push(`\n**Rules:**\n\n${ic.rules.map((r) => `- ${r}`).join("\n")}\n`);
		}
		for (const b of ic.bindings) {
			lines.push(`\n**Binding (${b.language}) — ${b.files.join(", ")}:**\n\n\`\`\`${b.language}\n${b.definition.trim()}\n\`\`\`\n`);
		}
		if (ic.fixtures && ic.fixtures.length > 0) {
			lines.push(`\n**Golden fixtures:** ${ic.fixtures.map((f) => f.name).join(", ")}\n`);
		}
	}
	return lines.join("");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/context-pack-builder.test.ts -t "interface contracts"`
Expected: PASS (both cases — the budget case passes because `pushAlways` bypasses the token budget).

- [ ] **Step 5: Run the full context-pack suite (regression)**

Run: `npx vitest run tests/unit/context-pack-builder.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/memory/governance/ContextPackBuilder.ts tests/unit/context-pack-builder.test.ts
git commit -m "feat(contracts): render Module Interface Contracts section in ContextPack"
```

---

## Task 6: Plan-gate — deterministic interface-violation pre-check

Before the master LLM audits an `<execution_plan>`, run a cheap deterministic check: if the plan's `files_to_change` touches a binding file owned by *another* task, it is an unauthorized signature change — REVISE without spending an LLM call. The master prompt still catches semantic end-runs the file check can't see.

**Files:**
- Modify: `src/orchestration/PlanGate.ts`
- Modify: `src/orchestration/index.ts` (export)
- Test: `tests/unit/plan-gate.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/plan-gate.test.ts`:

```ts
import { findInterfacePlanViolations } from "../../src/orchestration/index.js";
import type { InterfaceContract } from "../../src/orchestration/index.js";

const ic: InterfaceContract = {
	id: "IC", boundary: "api_rpc", schema: "s", rules: [],
	bindings: [{ language: "typescript", files: ["src/shared/api.ts"], definition: "export {}" }],
	ownerTaskId: "T1-scaffold", consumerTaskIds: ["T2-be"], revision: 1,
};

describe("findInterfacePlanViolations", () => {
	it("flags a consumer plan editing an interface file it does not own", () => {
		const issues = findInterfacePlanViolations(["src/shared/api.ts", "src/backend/handler.ts"], "T2-be", [ic]);
		expect(issues.some((i) => i.includes("src/shared/api.ts"))).toBe(true);
	});

	it("allows the owner to edit its own interface file", () => {
		const issues = findInterfacePlanViolations(["src/shared/api.ts"], "T1-scaffold", [ic]);
		expect(issues).toEqual([]);
	});

	it("allows a consumer plan touching only its own files", () => {
		const issues = findInterfacePlanViolations(["src/backend/handler.ts"], "T2-be", [ic]);
		expect(issues).toEqual([]);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/plan-gate.test.ts -t findInterfacePlanViolations`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

In `src/orchestration/PlanGate.ts`, add the imports and function. At the top:

```ts
import { matchGlob, normalizeRelPath } from "../tools/policy/PathPolicyEnforcer.js";
import type { InterfaceContract } from "./TaskContract.js";
```

Add near the bottom (before the final `PlanMode` type):

```ts
/**
 * Structured input the master audits at the W2-plan gate. Carries the task's
 * frozen interface contracts so the audit can reject a plan that rewrites a
 * surface it does not own. (The master prompt renders these fields.)
 */
export interface PlanAuditInput {
	taskId: string;
	objective: string;
	allowedGlobs: string[];
	acceptance: string[];
	nonGoals: string[];
	interfaceContracts: InterfaceContract[];
	executionPlan: string;
}

/**
 * Deterministic backstop run before the LLM audit: a plan whose files_to_change
 * touches a binding file owned by another task is an unauthorized signature
 * change. Returns a flat list of violations; empty means clean.
 */
export function findInterfacePlanViolations(
	filesToChange: string[],
	taskId: string,
	interfaceContracts: InterfaceContract[],
): string[] {
	const out: string[] = [];
	const planned = filesToChange.map((f) => normalizeRelPath(f));
	for (const ic of interfaceContracts) {
		if (ic.ownerTaskId === taskId) continue; // owner may edit its own surface
		const owned = ic.bindings.flatMap((b) => b.files.map((f) => normalizeRelPath(f)));
		for (const file of planned) {
			if (owned.some((g) => matchGlob(file, g) || file === g)) {
				out.push(`plan for ${taskId} edits interface file ${file} owned by ${ic.ownerTaskId} (contract ${ic.id}); return blocked to change the contract`);
			}
		}
	}
	return out;
}
```

- [ ] **Step 4: Export from the barrel**

In `src/orchestration/index.ts`, extend the `PlanGate.js` export block:

```ts
export {
	compilePlanAudit,
	extractExecutionPlan,
	findInterfacePlanViolations,
	needsPlanApproval,
	type PlanAuditInput,
	type PlanMode,
} from "./PlanGate.js";
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/unit/plan-gate.test.ts -t findInterfacePlanViolations`
Expected: PASS (all three cases).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/PlanGate.ts src/orchestration/index.ts tests/unit/plan-gate.test.ts
git commit -m "feat(contracts): deterministic interface-violation pre-check for plan gate"
```

---

## Task 7: Master prompt — W0 scaffold node + W0.5 interfaceContracts output

**Files:**
- Modify: `src/personas/prompts/master-planner/w0.md`
- Modify: `src/personas/prompts/master-planner/w05.md`

- [ ] **Step 1: Add the W0 scaffold-node rule**

Append to `src/personas/prompts/master-planner/w0.md`:

```markdown
## Interface Scaffold Nodes (W0)

When you intend to split one module across **two or more tasks that run in the
same `parallelGroup` and must agree on a shared surface** (e.g. a frontend and a
backend over an API, two backend modules over a function/data boundary, or two
algorithm stages over a data shape), emit a dedicated scaffold node in the coarse
DAG *before* those implementation tasks:

- persona: `code_executor`, `needs_refine: true`.
- objective: "write the interface/contract files for <surface>".
- Every implementation task that shares the surface must `dependsOn` this node.

You fill the scaffold node's actual interface definitions in W0.5
(`interfaceContracts`). Do NOT add a scaffold node for a single-file change or a
purely sequential chain (A then B) — there the downstream task sees A's real
output and needs no frozen surface.
```

- [ ] **Step 2: Add the W0.5 interfaceContracts output spec**

Append to `src/personas/prompts/master-planner/w05.md`:

```markdown
## Module Interface Contracts (W0.5)

When the coarse DAG has an interface scaffold node, author the frozen surface on
**that scaffold task's** refine entry via `interfaceContracts`. You design the
interface; you do not write business code. The scaffold task lands the binding
files verbatim; implementation tasks import them and may never change a signature.

The contract is language-neutral at its core (`schema` + `rules` + `fixtures`)
with one `binding` per consuming language, materialized in that language's idiom
(TypeScript `interface`/`type`, Python `dataclass`/`TypedDict`/`Protocol`, Go
struct/interface, Rust struct/trait, Java interface). Pick the language(s) from
repo_scout's `tech_stack`.

```
{ "taskId": "T1-scaffold",
  "allowedGlobs": ["src/shared/api.ts"],
  "acceptance": ["src/shared/api.ts type-checks"],
  "nonGoals": ["no business logic in the contract files"],
  "blockedCondition": "blocked if tech_stack is unavailable or incomplete",
  "interfaceContracts": [
    { "id": "IC-todo-api",
      "boundary": "api_rpc",
      "schema": "Routes: { listTodos: GET /api/todos, createTodo: POST /api/todos }\nTodo { id: string, title: string, done: boolean }\nApiError { code: 'VALIDATION'|'NOT_FOUND', message: string }",
      "rules": ["createTodo with empty title returns 400 + ApiError{code:VALIDATION}",
                "listTodos on empty set returns [] not null"],
      "fixtures": [{ "name": "one_todo", "data": { "id": "a", "title": "t", "done": false } }],
      "bindings": [
        { "language": "typescript", "files": ["src/shared/api.ts"],
          "definition": "export const Routes = {...} as const;\nexport interface Todo { id: string; title: string; done: boolean }\n..." }
      ],
      "ownerTaskId": "T1-scaffold",
      "consumerTaskIds": ["T2-backend", "T3-frontend"],
      "revision": 1 }
  ]
}
```

Hard rules:

- The owner scaffold task's `allowedGlobs` MUST cover every `bindings[].files`
  path; every consumer's `allowedGlobs` MUST NOT include them. Violations are
  rejected by interface-contract validation.
- Every `consumerTaskIds` task must (transitively) `dependsOn` the owner.
- For a polyglot boundary, emit one `binding` per side sharing the same `schema`
  and `fixtures`. There is no shared file across languages — the `contract_test`
  task proves the sides agree.
- Add a `contract_test` task (persona `test_writer` → `test_runner`) that
  `dependsOn` all consumers and validates real boundary data against `fixtures`
  and `rules`. This is the only conformance check that works for dynamically
  typed or cross-process boundaries.
- `interfaceContracts` is required only for a shared parallel surface. Omit it
  for single-file edits, sequential chains, and read-only / docs / audit tasks.
```

- [ ] **Step 3: Verify prompts are valid markdown (no build step needed)**

Run: `npx vitest run tests/unit/refiner.test.ts`
Expected: PASS (prompt edits don't affect parsing tests; this just confirms nothing regressed).

- [ ] **Step 4: Commit**

```bash
git add src/personas/prompts/master-planner/w0.md src/personas/prompts/master-planner/w05.md
git commit -m "docs(prompts): master W0 scaffold nodes + W0.5 interface contract output"
```

---

## Task 8: Audit + implementer prompts — freeze the signature

**Files:**
- Modify: `src/personas/prompts/master-planner/w2-plan.md`
- Modify: `src/personas/prompts/code-executor.md`
- Modify: `src/personas/prompts/test-writer.md`

- [ ] **Step 1: Add the W2 audit item**

In `src/personas/prompts/master-planner/w2-plan.md`, add to the "Audit checklist" bullet list (after the `nonGoals` bullet):

```markdown
- No `files_to_change` path edits an interface binding file owned by a *different*
  task. A consumer planning to modify a frozen surface must instead return
  blocked so you can amend the contract. (A deterministic pre-check already flags
  obvious cases; reject any subtler attempt to redefine an owned signature.)
```

- [ ] **Step 2: Add the implementer rule to code-executor**

Append to `src/personas/prompts/code-executor.md`:

```markdown
## Module Interface Contracts

When your Context Pack contains a `## Module Interface Contracts` section:

- Implement *against* each contract's binding — match the signatures exactly.
- You may freely write your own implementation files (your `allowedGlobs`).
- You may NOT change an interface binding's signature. If you are the CONSUMER,
  the binding files are not in your `allowedGlobs` and writes to them are denied.
- If the contract is wrong or insufficient for the task, do not work around it
  silently: stop and return `<status>blocked</status>` with a concrete proposed
  change to the contract (which symbol/field/rule and why). The master amends the
  contract; you do not.
```

- [ ] **Step 3: Add the rule to test-writer**

Append to `src/personas/prompts/test-writer.md`:

```markdown
## Contract Tests

When your Context Pack contains a `## Module Interface Contracts` section and your
task is the `contract_test` for a surface:

- Write tests that exercise *real boundary data* against the contract's `rules`
  and golden `fixtures` — not just type-level assertions.
- For a same-language boundary the binding's types already give compile-time
  coverage; your job is the semantics (status codes, null/empty conventions,
  units, ordering) the types cannot express.
- For a polyglot or cross-process boundary, assert that the producer's output and
  the consumer's expected input both conform to the shared `fixtures`.
- Never edit the interface binding files. To change the contract, return
  `<status>blocked</status>` with the proposed change.
```

- [ ] **Step 4: Confirm nothing regressed**

Run: `npm test`
Expected: PASS (prompt-only edits).

- [ ] **Step 5: Commit**

```bash
git add src/personas/prompts/master-planner/w2-plan.md src/personas/prompts/code-executor.md src/personas/prompts/test-writer.md
git commit -m "docs(prompts): freeze interface signatures for auditor + implementers"
```

---

## Task 9: Regression — no-contract tasks unaffected

**Files:**
- Test: `tests/unit/refiner.test.ts`

- [ ] **Step 1: Write the regression test**

Add to `tests/unit/refiner.test.ts` inside `describe("refineDag", ...)`:

```ts
	it("leaves interfaceContracts undefined for tasks with no shared surface", () => {
		const dag = mkDag();
		const refinement = new Map<string, RefinementEntry>([
			["T2-1", { taskId: "T2-1", allowedGlobs: ["src/upload.ts"], acceptance: ["ok"], nonGoals: ["no"], blockedCondition: "blocked if T0-1.file_list is unavailable" }],
		]);
		const { contracts, errors } = refineDag(dag, { inputs: baseInputs, refinement });
		expect(errors).toEqual([]);
		expect(contracts[0]!.interfaceContracts).toBeUndefined();
	});
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run tests/unit/refiner.test.ts -t "no shared surface"`
Expected: PASS — confirms the feature is opt-in and does not perturb existing flows.

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: PASS.
Run: `npm run typecheck` and `npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/refiner.test.ts
git commit -m "test(contracts): regression — no-surface tasks carry no interface contracts"
```

---

## Self-Review

**Spec coverage:**
- "interfaceContracts field on TaskContract + RefinementEntry" → Tasks 1, 2. ✅
- "master writes definitions, scaffold task lands files" → Tasks 1 (`bindings[].definition`), 7 (W0/W0.5 prompts). ✅
- "ownerTaskId / consumerTaskIds / rules" → Task 1 type; Task 4 validation. ✅
- "ContextPackBuilder renders ## Module Interface Contracts" → Task 5. ✅
- "code_executor / test_writer: signature not changeable, return blocked" → Task 8. ✅
- "W2-plan gate: PlanAuditInput + reject unauthorized interface edits" → Task 6 (`PlanAuditInput`, `findInterfacePlanViolations`), Task 8 (prompt). ✅
- "allowedGlobs + interface boundary both enforced" → Task 4 couples them (owner-writes / consumer-cannot-write the binding files). ✅
- "support all languages minimum supports" → language-neutral `schema` + per-language `bindings`; enforcement keyed to detected `static_compile_commands` (Tier 1) + universal `contract_test` (Tier 2). No per-language code added. ✅
- "regression: no-surface / read-only / docs tasks not forced" → Task 9 + opt-in field. ✅
- Deferred (stated in Scope): amendment loop (`revision` field added now, scheduler invalidation later), AST diffing. ✅

**Placeholder scan:** Task 4 Step 3 intentionally shows a vestigial dedupe and Step 5 removes it — this is a real edit sequence, not a placeholder. All other steps contain complete code/commands.

**Type consistency:** `findInterfaceContractIssues(contracts)`, `findInterfacePlanViolations(filesToChange, taskId, interfaceContracts)`, `InterfaceContract` / `InterfaceBinding` / `InterfaceBoundaryKind`, `PlanAuditInput`, `renderInterfaceContracts(taskId, contracts)`, `distributeInterfaceContracts(contracts, refinement)` — names are used identically across tasks. `revision` defaults to 1 in both the parser (Task 2) and tests.

---

## Execution Notes

- The `contract_test` task type referenced in prompts uses existing personas (`test_writer` → `test_runner`); no new persona is introduced in this plan.
- Tier 1 enforcement is *free*: a consumer importing a binding it violates fails the existing `postStaticCompile` ([Refiner.ts:275](../../../src/orchestration/Refiner.ts)) for statically typed languages. No code change needed — it follows from the binding being a real import.
- The follow-up amendment-loop plan should reuse the `T3.5-` repair-task path ([Refiner.ts:322](../../../src/orchestration/Refiner.ts)) and key consumer invalidation off `InterfaceContract.revision` + `consumerTaskIds`.
