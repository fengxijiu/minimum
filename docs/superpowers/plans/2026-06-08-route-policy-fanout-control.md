# Route Policy Fan-Out Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add route-aware orchestration control so planner prompts, DAG validation, runtime scheduling, and worker budgets all enforce the same `route + small|medium|large|auto` fan-out policy.

**Architecture:** Introduce a `RoutePolicy` layer ahead of planner compilation. Explicit CLI/TUI hints and automatic classification both produce the same policy object, which is injected into planner prompts and then enforced by W0/W0.5 DAG diagnostics plus DynamicHarness concurrency caps. The first-class routes are `scan_only`, `direct_edit`, `audit_review`, `implementation`, `debug_fix`, `dependency_config`, and `full_pipeline`.

**Tech Stack:** TypeScript, Vitest, existing MiMo orchestration modules, TUI command parsing, master planner prompt files.

---

## File Structure

- Modify: `src/personas/prompts/master-planner.md`
  - Add the Route & Scale Selection Policy as the planner's soft constraint layer.
  - Include the five audit-review rules: scoped scouts, fine-grained reviewers, coarse-task-risk feedback, docs depending on reviewer reports, and registry-backed runtime concurrency.
- Create: `src/orchestration/RoutePolicy.ts`
  - Own route and fan-out types, explicit hint normalization, automatic classification, route defaults, task caps, granularity caps, persona caps, and route-specific execution depth.
- Modify: `src/orchestration/OrchestrationClassifier.ts`
  - Keep existing `OrchestrationMode` behavior for compatibility, but delegate richer route classification to `RoutePolicy.ts`.
- Modify: `src/orchestration/ClientAdapters.ts`
  - Pass route policy text into planner compile/refine calls.
- Modify: `src/orchestration/MiMoPipeline.ts`
  - Accept `routePolicy` / `routeHint`, compute defaults, run policy validation after W0 and W0.5, and feed coarse-task-risk feedback into existing auto-refine loops.
- Create: `src/orchestration/RoutePolicyValidator.ts`
  - Validate DAG/refined contracts against route-specific caps and granularity rules.
- Modify: `src/orchestration/DynamicHarness.ts`
  - Replace hardcoded persona cap `5` with route policy caps or PersonaRegistry caps.
- Modify: `src/orchestration/DagHarness.ts`
  - Add optional `routePolicy` to harness options.
- Modify: `src/orchestration/WorkerLoop.ts` and `src/orchestration/ClientAdapters.ts`
  - Allow route/persona execution depth to control `maxSteps`, while keeping persona `maxTokens` as the output token cap.
- Modify: `src/bridge/PipelineBridge.ts`
  - Accept route/fanout options from TUI and pass them to `runPipeline`.
- Modify: `tui/src/app.tsx`
  - Parse `/orchestrate --route <route> --fanout <scale>` and strip flags before sending the user request.
- Test: `tests/unit/route-policy.test.ts`
  - Classification, explicit hint parsing, default caps, and policy rendering.
- Test: `tests/unit/route-policy-validator.test.ts`
  - Audit-review coarse-task-risk diagnostics.
- Test: `tests/unit/pipeline-bridge.test.ts`
  - Planner prompt receives route policy. Note: this file currently has pre-existing conflict markers and must be cleaned or skipped before relying on the suite.
- Test: `tests/unit/mimo-pipeline.test.ts`
  - W0/W0.5 re-prompt behavior when the policy validator flags coarse tasks.
- Test: `tests/unit/dynamic-harness.test.ts`
  - Runtime uses route/persona caps rather than hardcoded `5`.
- Test: `tests/unit/personas.test.ts`
  - Master planner prompt contains route policy sections and audit-review special rules.

---

### Task 1: Add Route & Scale Policy To Planner Prompt

**Files:**
- Modify: `src/personas/prompts/master-planner.md`
- Modify: `tests/unit/personas.test.ts`

- [x] **Step 1: Write failing prompt tests**

Add assertions under the existing `master_planner prompt` describe block:

```ts
it("defines route and scale selection policy", () => {
	const sys = getPersona("master_planner").systemPrompt;
	expect(sys).toContain("Route & Scale Selection Policy");
	expect(sys).toContain("scan_only");
	expect(sys).toContain("direct_edit");
	expect(sys).toContain("audit_review");
	expect(sys).toContain("implementation");
	expect(sys).toContain("debug_fix");
	expect(sys).toContain("dependency_config");
	expect(sys).toContain("full_pipeline");
	expect(sys).toContain("small | medium | large | auto");
});

it("defines audit_review scoped scout and reviewer fan-out rules", () => {
	const sys = getPersona("master_planner").systemPrompt;
	expect(sys).toContain("repo_scout is a context probe, not a global single-point gate");
	expect(sys).toContain("Prefer scoped `repo_scout` tasks");
	expect(sys).toContain("One reviewer owns exactly one finding domain or one bounded file cluster");
	expect(sys).toContain("audit_review medium");
	expect(sys).toContain("3-5 reviewers");
	expect(sys).toContain("audit_review large");
	expect(sys).toContain("6-10 reviewers");
	expect(sys).toContain("docs depends on completed reviewer reports");
	expect(sys).toContain("Do not make the final docs task depend directly on `repo_scout.file_list`");
});
```

- [x] **Step 2: Run the failing tests**

Run:

```powershell
npm test -- tests/unit/personas.test.ts
```

Expected: FAIL because the new route policy text is not present.

- [x] **Step 3: Add the policy prompt**

In `src/personas/prompts/master-planner.md`, add a section before or inside the existing workload/fan-out policy:

```md
## Route & Scale Selection Policy

Before building the DAG, first decide:

- `route`: what execution path the request should use
- `scale`: how much fan-out the DAG should have

Accuracy has priority over token efficiency. Choose the smallest safe route and
scale, but do not under-route ambiguous, risky, cross-module, or mixed requests.

Routes:

- `scan_only`: read-only explanation, code reading, project exploration,
  architecture understanding, and Q&A. Default scale: `small`.
- `direct_edit`: small, explicit, low-risk patches. Default scale: `small`.
- `audit_review`: review-oriented work where the output is findings, risk
  assessment, or a report. Default scale: `medium`, upgrade to `large` for
  repo-wide dead-code, conflict, security, or quality audits.
- `implementation`: normal feature work, behavior changes, non-trivial
  refactors, or multi-file modifications. Default scale: `medium`.
- `debug_fix`: failures, regressions, runtime errors, broken tests, broken
  builds, failed commands, or unexpected behavior. Default scale: `medium`.
- `dependency_config`: dependency, package manager, build configuration,
  TypeScript config, lint config, CI config, lockfile, or toolchain work.
  Default scale: `small`.
- `full_pipeline`: fallback for mixed, unclear, high-risk, or low-confidence
  classification. Default scale: `auto`.

Scale values: `small | medium | large | auto`.

### audit_review Special Rules

For `audit_review`, `repo_scout` is a context probe, not a global single-point gate.

- Prefer scoped `repo_scout` tasks by module, file cluster, or finding domain.
- Do not make every reviewer hard-depend on one global `repo_scout.file_list`.
- If reviewer scope is already known from the user request or DAG context, the
  reviewer may proceed with bounded `allowedGlobs` without a required global
  `file_list`.

Reviewer tasks must be fine-grained.

- One reviewer owns exactly one finding domain or one bounded file cluster.
- Do not combine unrelated domains such as stale docs, utils dead exports, MCP
  wiring, TUI conflicts, and barrel export issues in one reviewer.
- For `audit_review medium`, prefer 3-5 reviewers.
- For `audit_review large`, prefer 6-10 reviewers.

Final docs consolidation depends on completed reviewer reports.

- `docs` depends on completed reviewer reports.
- Do not make the final docs task depend directly on `repo_scout.file_list`.
- Scout failure or degraded scout output must not block report consolidation if
  reviewer reports exist.
```

- [x] **Step 4: Run prompt tests**

Run:

```powershell
npm test -- tests/unit/personas.test.ts
```

Expected: PASS for the new prompt assertions.

---

### Task 2: Add RoutePolicy Types, Defaults, And Automatic Classification

**Files:**
- Create: `src/orchestration/RoutePolicy.ts`
- Modify: `src/orchestration/index.ts`
- Test: `tests/unit/route-policy.test.ts`

- [x] **Step 1: Write failing route policy tests**

Create `tests/unit/route-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	classifyRoutePolicy,
	normalizeRouteHint,
	renderRoutePolicyForPlanner,
} from "../../src/orchestration/RoutePolicy.js";

describe("RoutePolicy", () => {
	it("classifies dead-code and conflict audits as audit_review large", () => {
		const policy = classifyRoutePolicy("review dead code and cross-module conflicts across the repo");
		expect(policy.route).toBe("audit_review");
		expect(policy.scale).toBe("large");
		expect(policy.taskCaps.reviewer.min).toBe(6);
		expect(policy.taskCaps.reviewer.max).toBe(10);
		expect(policy.granularityCaps.reviewerMaxDomains).toBe(1);
	});

	it("honors explicit route and fanout hints", () => {
		const policy = classifyRoutePolicy("check dead exports", {
			route: "audit_review",
			scale: "medium",
		});
		expect(policy.source).toBe("explicit");
		expect(policy.route).toBe("audit_review");
		expect(policy.scale).toBe("medium");
		expect(policy.taskCaps.reviewer.min).toBe(3);
		expect(policy.taskCaps.reviewer.max).toBe(5);
	});

	it("normalizes route hints and rejects unknown values", () => {
		expect(normalizeRouteHint({ route: "audit_review", scale: "large" })).toEqual({
			route: "audit_review",
			scale: "large",
		});
		expect(() => normalizeRouteHint({ route: "unknown", scale: "large" })).toThrow(/route/i);
		expect(() => normalizeRouteHint({ route: "audit_review", scale: "huge" })).toThrow(/scale/i);
	});

	it("renders planner policy text with caps and reasons", () => {
		const policy = classifyRoutePolicy("audit dead code", { route: "audit_review", scale: "large" });
		const text = renderRoutePolicyForPlanner(policy);
		expect(text).toContain("# Route Policy");
		expect(text).toContain("route: audit_review");
		expect(text).toContain("scale: large");
		expect(text).toContain("reviewer: 6-10");
		expect(text).toContain("repo_scout is a context probe");
	});
});
```

- [x] **Step 2: Run the failing tests**

Run:

```powershell
npm test -- tests/unit/route-policy.test.ts
```

Expected: FAIL because `RoutePolicy.ts` does not exist.

- [x] **Step 3: Implement `RoutePolicy.ts`**

Create `src/orchestration/RoutePolicy.ts`:

```ts
import type { PersonaId } from "../personas/Persona.js";
import type { ExecutionDepth } from "./ExecutionBudget.js";

export type OrchestrationRoute =
	| "scan_only"
	| "direct_edit"
	| "audit_review"
	| "implementation"
	| "debug_fix"
	| "dependency_config"
	| "full_pipeline";

export type FanoutScale = "small" | "medium" | "large" | "auto";

export interface RouteHint {
	route?: string;
	scale?: string;
}

export interface CountCap {
	min: number;
	max: number;
}

export interface RoutePolicy {
	route: OrchestrationRoute;
	scale: FanoutScale;
	source: "explicit" | "auto";
	confidence: "low" | "medium" | "high";
	reasons: string[];
	taskCaps: Partial<Record<PersonaId, CountCap>>;
	personaCaps: Partial<Record<PersonaId, number>>;
	granularityCaps: {
		reviewerMaxDomains: number;
		reviewerMaxCoreFiles: number;
		executorMaxFiles: number;
		testWriterMaxAcceptance: number;
		contextPackMaxTokens: number;
	};
	executionDepthByPersona: Partial<Record<PersonaId, ExecutionDepth>>;
}

const ROUTES = new Set<OrchestrationRoute>([
	"scan_only",
	"direct_edit",
	"audit_review",
	"implementation",
	"debug_fix",
	"dependency_config",
	"full_pipeline",
]);

const SCALES = new Set<FanoutScale>(["small", "medium", "large", "auto"]);

export function normalizeRouteHint(hint?: RouteHint): { route?: OrchestrationRoute; scale?: FanoutScale } {
	const out: { route?: OrchestrationRoute; scale?: FanoutScale } = {};
	if (hint?.route !== undefined) {
		const route = hint.route.trim().toLowerCase().replace(/-/g, "_") as OrchestrationRoute;
		if (!ROUTES.has(route)) throw new Error(`unknown orchestration route: ${hint.route}`);
		out.route = route;
	}
	if (hint?.scale !== undefined) {
		const scale = hint.scale.trim().toLowerCase() as FanoutScale;
		if (!SCALES.has(scale)) throw new Error(`unknown fanout scale: ${hint.scale}`);
		out.scale = scale;
	}
	return out;
}

export function classifyRoutePolicy(userRequest: string, hint?: RouteHint): RoutePolicy {
	const normalized = normalizeRouteHint(hint);
	const lower = userRequest.toLowerCase();
	const explicit = normalized.route !== undefined || normalized.scale !== undefined;

	const autoRoute = inferRoute(lower);
	const route = normalized.route ?? autoRoute.route;
	const scale = normalized.scale ?? inferScale(route, lower);
	return buildRoutePolicy({
		route,
		scale,
		source: explicit ? "explicit" : "auto",
		confidence: explicit ? "high" : autoRoute.confidence,
		reasons: explicit ? ["explicit route/fanout hint"] : autoRoute.reasons,
	});
}

function inferRoute(lower: string): Pick<RoutePolicy, "route" | "confidence" | "reasons"> {
	if (/(dead code|conflict|audit|review|security|quality|report|冗余|冲突|审计|评审|报告|坏味道)/i.test(lower)) {
		return { route: "audit_review", confidence: "high", reasons: ["review/audit keyword"] };
	}
	if (/(error|failed|failing|crash|regression|stack trace|报错|失败|回归|崩溃)/i.test(lower)) {
		return { route: "debug_fix", confidence: "high", reasons: ["failure/debug keyword"] };
	}
	if (/(package\.json|lockfile|tsconfig|build config|lint|ci|dependency|toolchain|依赖|构建|配置)/i.test(lower)) {
		return { route: "dependency_config", confidence: "high", reasons: ["dependency/config keyword"] };
	}
	if (/(explain|analyze|describe|what is|how does|查看|分析|解释|怎么工作|理解)/i.test(lower) && !/(fix|patch|修改|实现)/i.test(lower)) {
		return { route: "scan_only", confidence: "medium", reasons: ["read-only exploration keyword"] };
	}
	if (/(small patch|typo|narrow|specific file|小修|小 patch|局部)/i.test(lower)) {
		return { route: "direct_edit", confidence: "medium", reasons: ["small edit keyword"] };
	}
	if (/(implement|feature|refactor|support|add|修改行为|实现|功能|重构|接入)/i.test(lower)) {
		return { route: "implementation", confidence: "medium", reasons: ["implementation keyword"] };
	}
	return { route: "full_pipeline", confidence: "low", reasons: ["fallback: mixed or unclear request"] };
}

function inferScale(route: OrchestrationRoute, lower: string): FanoutScale {
	if (route === "full_pipeline") return "auto";
	if (route === "scan_only" || route === "direct_edit") return "small";
	if (/(repo-wide|whole repo|across the repo|cross-module|many modules|migration|全仓|跨模块|大范围)/i.test(lower)) return "large";
	if (route === "dependency_config") return "small";
	return "medium";
}

function buildRoutePolicy(input: Pick<RoutePolicy, "route" | "scale" | "source" | "confidence" | "reasons">): RoutePolicy {
	const taskCaps = taskCapsFor(input.route, input.scale);
	return {
		...input,
		taskCaps,
		personaCaps: personaCapsFor(input.route, input.scale),
		granularityCaps: granularityCapsFor(input.scale),
		executionDepthByPersona: executionDepthFor(input.route, input.scale),
	};
}

function taskCapsFor(route: OrchestrationRoute, scale: FanoutScale): RoutePolicy["taskCaps"] {
	if (route === "audit_review") {
		if (scale === "large") return { repo_scout: { min: 2, max: 4 }, reviewer: { min: 6, max: 10 }, docs: { min: 1, max: 1 } };
		if (scale === "medium") return { repo_scout: { min: 1, max: 2 }, reviewer: { min: 3, max: 5 }, docs: { min: 1, max: 1 } };
		return { repo_scout: { min: 1, max: 1 }, reviewer: { min: 2, max: 2 }, docs: { min: 1, max: 1 } };
	}
	if (route === "implementation") {
		if (scale === "large") return { repo_scout: { min: 2, max: 4 }, test_writer: { min: 3, max: 6 }, code_executor: { min: 3, max: 6 }, test_runner: { min: 2, max: 4 }, reviewer: { min: 1, max: 2 }, docs: { min: 1, max: 1 } };
		if (scale === "medium") return { repo_scout: { min: 1, max: 2 }, test_writer: { min: 2, max: 3 }, code_executor: { min: 2, max: 3 }, test_runner: { min: 2, max: 2 }, reviewer: { min: 1, max: 1 } };
		return { repo_scout: { min: 1, max: 1 }, test_writer: { min: 1, max: 1 }, code_executor: { min: 1, max: 1 }, test_runner: { min: 1, max: 2 } };
	}
	if (route === "debug_fix") {
		if (scale === "large") return { runtime_debug: { min: 1, max: 2 }, code_executor: { min: 2, max: 3 }, test_runner: { min: 2, max: 3 }, reviewer: { min: 1, max: 2 } };
		if (scale === "medium") return { runtime_debug: { min: 1, max: 1 }, code_executor: { min: 1, max: 2 }, test_runner: { min: 1, max: 2 }, reviewer: { min: 1, max: 1 } };
		return { runtime_debug: { min: 1, max: 1 }, code_executor: { min: 1, max: 1 }, test_runner: { min: 1, max: 1 } };
	}
	if (route === "dependency_config") {
		if (scale === "large") return { repo_scout: { min: 1, max: 2 }, code_executor: { min: 2, max: 3 }, test_runner: { min: 2, max: 3 }, reviewer: { min: 1, max: 1 } };
		if (scale === "medium") return { repo_scout: { min: 1, max: 1 }, code_executor: { min: 1, max: 2 }, test_runner: { min: 1, max: 2 } };
		return { repo_scout: { min: 1, max: 1 }, code_executor: { min: 1, max: 1 }, test_runner: { min: 1, max: 1 } };
	}
	if (route === "direct_edit") return { repo_scout: { min: 1, max: 1 }, code_executor: { min: 1, max: 1 }, test_runner: { min: 0, max: 1 } };
	if (route === "scan_only") return { repo_scout: { min: 1, max: 1 } };
	return {};
}

function personaCapsFor(route: OrchestrationRoute, scale: FanoutScale): RoutePolicy["personaCaps"] {
	const reviewer = scale === "large" ? 3 : scale === "medium" ? 2 : 1;
	return {
		repo_scout: scale === "large" ? 4 : 2,
		reviewer,
		code_executor: route === "dependency_config" ? 1 : scale === "large" ? 3 : 2,
		test_writer: scale === "large" ? 3 : 2,
		test_runner: scale === "large" ? 3 : 2,
		runtime_debug: 1,
		context_builder: 1,
		docs: 1,
		vision: 1,
		web_searcher: 2,
	};
}

function granularityCapsFor(scale: FanoutScale): RoutePolicy["granularityCaps"] {
	return {
		reviewerMaxDomains: 1,
		reviewerMaxCoreFiles: scale === "large" ? 8 : 5,
		executorMaxFiles: 5,
		testWriterMaxAcceptance: 3,
		contextPackMaxTokens: scale === "large" ? 6_000 : scale === "medium" ? 5_000 : 3_000,
	};
}

function executionDepthFor(route: OrchestrationRoute, scale: FanoutScale): RoutePolicy["executionDepthByPersona"] {
	return {
		repo_scout: "normal",
		reviewer: scale === "small" ? "fast" : "normal",
		code_executor: scale === "large" && route === "implementation" ? "deep" : "normal",
		test_writer: "normal",
		test_runner: "fast",
		runtime_debug: "deep",
		docs: scale === "large" ? "normal" : "fast",
	};
}

export function renderRoutePolicyForPlanner(policy: RoutePolicy): string {
	const caps = Object.entries(policy.taskCaps)
		.map(([persona, cap]) => `- ${persona}: ${cap.min}-${cap.max}`)
		.join("\n");
	return [
		"# Route Policy",
		`route: ${policy.route}`,
		`scale: ${policy.scale}`,
		`source: ${policy.source}`,
		`confidence: ${policy.confidence}`,
		"reasons:",
		...policy.reasons.map((reason) => `- ${reason}`),
		"",
		"task caps:",
		caps || "- (none)",
		"",
		"audit_review rules:",
		"- repo_scout is a context probe, not a global single-point gate.",
		"- Prefer scoped repo_scout tasks by module, file cluster, or finding domain.",
		"- One reviewer owns exactly one finding domain or one bounded file cluster.",
		"- docs depends on completed reviewer reports, not repo_scout.file_list.",
	].join("\n");
}
```

- [x] **Step 4: Export the module**

Add to `src/orchestration/index.ts`:

```ts
export {
	classifyRoutePolicy,
	normalizeRouteHint,
	renderRoutePolicyForPlanner,
	type FanoutScale,
	type OrchestrationRoute,
	type RouteHint,
	type RoutePolicy,
} from "./RoutePolicy.js";
```

- [x] **Step 5: Run route policy tests**

Run:

```powershell
npm test -- tests/unit/route-policy.test.ts
```

Expected: PASS.

---

### Task 3: Parse Explicit Route/Fanout Flags In TUI And Bridge

**Files:**
- Modify: `tui/src/app.tsx`
- Modify: `src/bridge/PipelineBridge.ts`
- Modify: `src/orchestration/MiMoPipeline.ts`
- Test: add focused tests if a TUI command parser helper exists; otherwise cover through bridge/pipeline unit tests.

- [x] **Step 1: Extract route flags from `/orchestrate` input**

Add a helper near the TUI command handling code:

```ts
function parseOrchestrateFlags(input: string): {
	cleanInput: string;
	routeHint?: { route?: string; scale?: string };
} {
	const tokens = input.trim().split(/\s+/);
	const kept: string[] = [];
	const routeHint: { route?: string; scale?: string } = {};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--route" && tokens[i + 1]) {
			routeHint.route = tokens[++i];
			continue;
		}
		if ((token === "--fanout" || token === "--scale") && tokens[i + 1]) {
			routeHint.scale = tokens[++i];
			continue;
		}
		kept.push(token);
	}
	return {
		cleanInput: kept.join(" ").trim(),
		routeHint: routeHint.route || routeHint.scale ? routeHint : undefined,
	};
}
```

- [x] **Step 2: Pass route hints into `PipelineBridge`**

Extend the call path so `/orchestrate --route audit_review --fanout large ...` sends the clean user request and route hint to the pipeline runner. The final `effectiveInput` must not include the flags.

- [x] **Step 3: Add pipeline option types**

In `src/orchestration/MiMoPipeline.ts`, extend `PipelineOptions`:

```ts
import type { RouteHint, RoutePolicy } from "./RoutePolicy.js";

export interface PipelineOptions {
	// existing fields...
	routeHint?: RouteHint;
	routePolicy?: RoutePolicy;
}
```

- [x] **Step 4: Run focused smoke test**

Run:

```powershell
npx tsx -e "import('./tui/src/app.tsx').then(() => console.log('ok'))"
```

Expected: prints `ok`.

---

### Task 4: Inject RoutePolicy Into Planner Compile And Refine

**Files:**
- Modify: `src/orchestration/ClientAdapters.ts`
- Modify: `src/orchestration/MiMoPipeline.ts`
- Test: `tests/unit/pipeline-bridge.test.ts` or a new focused planner adapter test

- [x] **Step 1: Write failing planner adapter test**

If `tests/unit/pipeline-bridge.test.ts` is usable after resolving its existing conflict markers, add:

```ts
it("injects route policy into planner compile prompts", async () => {
	const client = scriptedClient([DAG]);
	const planner = createPlannerBridge(client, {
		routePolicy: classifyRoutePolicy("audit dead code", { route: "audit_review", scale: "large" }),
	});
	await planner.compile("audit dead code", "MEM");
	const text = client.calls[0]!.messages.map((m) => m.content).join("\n");
	expect(text).toContain("# Route Policy");
	expect(text).toContain("route: audit_review");
	expect(text).toContain("scale: large");
	expect(text).toContain("reviewer: 6-10");
});
```

- [x] **Step 2: Extend planner bridge options**

In `src/orchestration/ClientAdapters.ts`:

```ts
import { renderRoutePolicyForPlanner, type RoutePolicy } from "./RoutePolicy.js";

export interface PlannerBridgeOptions {
	projectRoot?: string;
	maxTokens?: number;
	routePolicy?: RoutePolicy;
}
```

- [x] **Step 3: Append policy text to compile/refine user content**

In `compile`:

```ts
const routePolicyText = opts.routePolicy ? `\n\n${renderRoutePolicyForPlanner(opts.routePolicy)}` : "";
content: `${memoryPrefix}\n\n# User Request\n${userRequest}${routePolicyText}\n\nCompile the coarse task DAG now. Output a single <task_dag> block.`,
```

In `refine`, include the same policy text before the final instruction:

```ts
if (opts.routePolicy) {
	userContent.push(renderRoutePolicyForPlanner(opts.routePolicy));
}
```

- [x] **Step 4: Compute policy in `runPipeline`**

At the start of `runPipeline`:

```ts
const routePolicy = opts.routePolicy ?? classifyRoutePolicy(userRequest, opts.routeHint);
```

Pass this policy into the planner created by `PipelineBridge`.

- [x] **Step 5: Run planner adapter test**

Run:

```powershell
npm test -- tests/unit/pipeline-bridge.test.ts
```

Expected: PASS if the file is clean. If it still has pre-existing conflict markers, document that blocker and run the new focused test file instead.

---

### Task 5: Add RoutePolicyValidator And Coarse-Task-Risk Diagnostics

**Files:**
- Create: `src/orchestration/RoutePolicyValidator.ts`
- Modify: `src/orchestration/MiMoPipeline.ts`
- Test: `tests/unit/route-policy-validator.test.ts`

- [x] **Step 1: Write failing validator tests**

Create `tests/unit/route-policy-validator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyRoutePolicy } from "../../src/orchestration/RoutePolicy.js";
import { validateAgainstRoutePolicy } from "../../src/orchestration/RoutePolicyValidator.js";
import type { TaskContract } from "../../src/orchestration/TaskContract.js";

function contract(overrides: Partial<TaskContract>): TaskContract {
	return {
		taskId: overrides.taskId ?? "T1",
		phase: "P1",
		epicId: "audit",
		personaId: overrides.personaId ?? "reviewer",
		objective: overrides.objective ?? "review utils dead exports and MCP wiring",
		inputs: { userGoal: "audit", artifacts: [], constraints: [] },
		pathPolicy: { allowedGlobs: overrides.pathPolicy?.allowedGlobs ?? ["src/utils/**", "src/mcp/**"], forbiddenGlobs: [] },
		acceptance: overrides.acceptance ?? ["dead exports", "MCP wiring", "docs stale", "TUI conflicts"],
		nonGoals: [],
		blockedCondition: overrides.blockedCondition,
		launchRequirements: overrides.launchRequirements,
		outputSchema: "task_report",
		parallelGroup: "review",
		dependsOn: overrides.dependsOn ?? ["T0-1"],
		grantedSkills: [],
		grantedMcpTools: [],
		abortOnConflict: false,
	};
}

describe("RoutePolicyValidator", () => {
	it("flags audit_review large when reviewer fan-out is below the minimum", () => {
		const policy = classifyRoutePolicy("repo-wide dead code conflict audit", { route: "audit_review", scale: "large" });
		const issues = validateAgainstRoutePolicy({
			routePolicy: policy,
			contracts: [contract({ taskId: "T1" }), contract({ taskId: "D1", personaId: "docs", dependsOn: ["T1"] })],
		});
		expect(issues.map((i) => i.code)).toContain("audit_review_reviewer_under_fanout");
	});

	it("flags a broad reviewer that mixes multiple domains", () => {
		const policy = classifyRoutePolicy("audit dead code", { route: "audit_review", scale: "medium" });
		const issues = validateAgainstRoutePolicy({ routePolicy: policy, contracts: [contract({ taskId: "T1" })] });
		expect(issues.map((i) => i.code)).toContain("reviewer_scope_too_broad");
	});

	it("flags all reviewers hard-depending on the same scout file_list", () => {
		const policy = classifyRoutePolicy("audit dead code", { route: "audit_review", scale: "medium" });
		const reviewers = ["T1", "T2", "T3"].map((taskId) => contract({
			taskId,
			objective: `${taskId} scoped review`,
			acceptance: ["one domain"],
			pathPolicy: { allowedGlobs: ["src/utils/**"], forbiddenGlobs: [] },
			launchRequirements: [{ sourceTaskId: "T0-1", artifact: "file_list", required: true }],
		}));
		const issues = validateAgainstRoutePolicy({ routePolicy: policy, contracts: reviewers });
		expect(issues.map((i) => i.code)).toContain("single_scout_file_list_bottleneck");
	});

	it("flags docs depending directly on repo_scout file_list", () => {
		const policy = classifyRoutePolicy("audit dead code", { route: "audit_review", scale: "medium" });
		const issues = validateAgainstRoutePolicy({
			routePolicy: policy,
			contracts: [
				contract({ taskId: "T0-1", personaId: "repo_scout", dependsOn: [] }),
				contract({ taskId: "D1", personaId: "docs", dependsOn: ["T0-1"], launchRequirements: [{ sourceTaskId: "T0-1", artifact: "file_list", required: true }] }),
			],
		});
		expect(issues.map((i) => i.code)).toContain("docs_depends_on_scout_file_list");
	});
});
```

- [x] **Step 2: Run failing validator tests**

Run:

```powershell
npm test -- tests/unit/route-policy-validator.test.ts
```

Expected: FAIL because the validator does not exist.

- [x] **Step 3: Implement validator**

Create `src/orchestration/RoutePolicyValidator.ts`:

```ts
import type { PersonaId } from "../personas/Persona.js";
import type { RoutePolicy } from "./RoutePolicy.js";
import type { CoarseDag, TaskContract } from "./TaskContract.js";

export interface RoutePolicyIssue {
	code:
		| "audit_review_reviewer_under_fanout"
		| "audit_review_reviewer_over_fanout"
		| "reviewer_scope_too_broad"
		| "single_scout_file_list_bottleneck"
		| "docs_depends_on_scout_file_list";
	taskId?: string;
	message: string;
}

export function validateAgainstRoutePolicy(input: {
	routePolicy: RoutePolicy;
	contracts: TaskContract[];
	dag?: CoarseDag;
}): RoutePolicyIssue[] {
	const { routePolicy, contracts } = input;
	if (routePolicy.route !== "audit_review") return [];

	const issues: RoutePolicyIssue[] = [];
	const reviewers = contracts.filter((c) => c.personaId === "reviewer");
	const reviewerCap = routePolicy.taskCaps.reviewer;
	if (reviewerCap && reviewers.length < reviewerCap.min) {
		issues.push({
			code: "audit_review_reviewer_under_fanout",
			message: `audit_review ${routePolicy.scale} requires ${reviewerCap.min}-${reviewerCap.max} reviewers, got ${reviewers.length}`,
		});
	}
	if (reviewerCap && reviewers.length > reviewerCap.max) {
		issues.push({
			code: "audit_review_reviewer_over_fanout",
			message: `audit_review ${routePolicy.scale} allows at most ${reviewerCap.max} reviewers, got ${reviewers.length}`,
		});
	}

	for (const reviewer of reviewers) {
		if (isBroadReviewer(reviewer, routePolicy)) {
			issues.push({
				code: "reviewer_scope_too_broad",
				taskId: reviewer.taskId,
				message: `${reviewer.taskId} mixes multiple finding domains or unrelated file clusters; split by domain or bounded file cluster`,
			});
		}
	}

	if (reviewers.length >= 2 && reviewers.every((r) => requiresSameScoutFileList(r, reviewers[0]!))) {
		issues.push({
			code: "single_scout_file_list_bottleneck",
			message: "all audit reviewers hard-depend on the same repo_scout.file_list; use scoped scouts or optional requirements for known file clusters",
		});
	}

	for (const docs of contracts.filter((c) => c.personaId === "docs")) {
		const dependsOnScout = docs.dependsOn.some((dep) => contracts.find((c) => c.taskId === dep)?.personaId === "repo_scout");
		const requiresScoutFileList = (docs.launchRequirements ?? []).some((req) => req.artifact === "file_list" && contracts.find((c) => c.taskId === req.sourceTaskId)?.personaId === "repo_scout");
		if (dependsOnScout || requiresScoutFileList) {
			issues.push({
				code: "docs_depends_on_scout_file_list",
				taskId: docs.taskId,
				message: `${docs.taskId} should depend on reviewer task_report outputs, not repo_scout.file_list`,
			});
		}
	}

	return issues;
}

function isBroadReviewer(contract: TaskContract, policy: RoutePolicy): boolean {
	const objective = contract.objective.toLowerCase();
	const domainMatches = [
		/dead|unused|冗余/,
		/conflict|冲突/,
		/mcp/,
		/tui|frontend|ui/,
		/docs?|report|stale/,
		/barrel|export/,
		/security|安全/,
	].filter((re) => re.test(objective) || contract.acceptance.some((a) => re.test(a.toLowerCase()))).length;
	const rootDirs = new Set(
		contract.pathPolicy.allowedGlobs
			.map((glob) => glob.replace(/\\/g, "/").split("/")[0])
			.filter(Boolean),
	);
	return domainMatches > policy.granularityCaps.reviewerMaxDomains || rootDirs.size > 1 || contract.acceptance.length > 3;
}

function requiresSameScoutFileList(contract: TaskContract, first: TaskContract): boolean {
	const req = (contract.launchRequirements ?? []).find((r) => r.artifact === "file_list" && r.required !== false);
	const firstReq = (first.launchRequirements ?? []).find((r) => r.artifact === "file_list" && r.required !== false);
	return req !== undefined && firstReq !== undefined && req.sourceTaskId === firstReq.sourceTaskId;
}
```

- [x] **Step 4: Run validator tests**

Run:

```powershell
npm test -- tests/unit/route-policy-validator.test.ts
```

Expected: PASS.

---

### Task 6: Wire Coarse-Task-Risk Into W0.5 Auto-Refine

**Files:**
- Modify: `src/orchestration/MiMoPipeline.ts`
- Test: `tests/unit/mimo-pipeline.test.ts`

- [x] **Step 1: Write failing pipeline test**

Add a test that stubs planner compile/refine with an `audit_review large` policy but only one broad reviewer. Expect the refine method to be called again with feedback containing `coarse-task-risk`.

```ts
it("reruns refine when audit_review route policy detects coarse reviewer tasks", async () => {
	const refineCalls: string[] = [];
	const planner = stubPlanner({
		compile: async () => `<task_dag>${JSON.stringify({
			epic: "audit",
			phases: [
				{ id: "P1", name: "scan", tasks: [{ id: "T0-1", persona: "repo_scout", objective: "scan repo", parallelGroup: "scan", dependsOn: [], needsRefine: false }] },
				{ id: "P2", name: "review", tasks: [{ id: "T1", persona: "reviewer", objective: "review utils dead exports, MCP wiring, stale docs, and TUI conflicts", parallelGroup: "review", dependsOn: ["T0-1"], needsRefine: true }] },
				{ id: "P3", name: "docs", tasks: [{ id: "D1", persona: "docs", objective: "write report", parallelGroup: "docs", dependsOn: ["T1"], needsRefine: true }] },
			],
		})}</task_dag>`,
		refine: async (_dag, _results, _memory, _catalog, feedback) => {
			refineCalls.push(feedback ?? "");
			return `<refine>${JSON.stringify({
				tasks: [
					{ taskId: "T1", allowedGlobs: ["src/utils/**", "src/mcp/**"], acceptance: ["dead exports", "MCP wiring", "stale docs", "TUI conflicts"], nonGoals: [], blockedCondition: "blocked if required review files are inaccessible" },
					{ taskId: "D1", allowedGlobs: ["docs/**"], acceptance: ["write report"], nonGoals: [], blockedCondition: "blocked if reviewer task_report is unavailable" },
				],
			})}</refine>`;
		},
	});
	await runPipeline("repo-wide dead code conflict audit", {
		projectRoot,
		planner,
		executor,
		choiceGate: continueGate(),
		routeHint: { route: "audit_review", scale: "large" },
	});
	expect(refineCalls.some((call) => call.includes("coarse-task-risk"))).toBe(true);
});
```

- [x] **Step 2: Run failing pipeline test**

Run:

```powershell
npm test -- tests/unit/mimo-pipeline.test.ts -t "reruns refine when audit_review"
```

Expected: FAIL because the policy validator is not wired into W0.5.

- [x] **Step 3: Add route policy validation after `refineDag`**

After `allContracts = refined.contracts; refineErrors = refined.errors;` in `MiMoPipeline.ts`:

```ts
const routePolicyIssues = validateAgainstRoutePolicy({ routePolicy, contracts: allContracts, dag });
if (routePolicyIssues.length > 0 && autoRefineRounds < MAX_AUTO_REFINE_ROUNDS) {
	autoRefineRounds++;
	refineFeedback = [
		"# coarse-task-risk",
		...routePolicyIssues.map((issue) => `- ${issue.code}${issue.taskId ? ` (${issue.taskId})` : ""}: ${issue.message}`),
		"",
		"Re-emit the ENTIRE <refine> block preserving task ids where possible. For audit_review, split broad reviewers by finding domain or bounded file cluster, avoid one global scout file_list gate, and make docs depend on reviewer task reports.",
	].join("\n");
	emit({ type: "pipeline_choice", phase: "W0.5", choiceId: "auto_rerun_refine", reason: "coarse-task-risk" });
	continue;
}
```

- [x] **Step 4: Run focused pipeline test**

Run:

```powershell
npm test -- tests/unit/mimo-pipeline.test.ts -t "reruns refine when audit_review"
```

Expected: PASS.

---

### Task 7: Use Registry And RoutePolicy Persona Caps In DynamicHarness

**Files:**
- Modify: `src/orchestration/DagHarness.ts`
- Modify: `src/orchestration/DynamicHarness.ts`
- Test: `tests/unit/dynamic-harness.test.ts`

- [x] **Step 1: Write failing harness test**

Add:

```ts
it("uses route policy persona caps instead of hardcoded cap 5", async () => {
	const started: string[] = [];
	const contracts = Array.from({ length: 4 }, (_, index) => mkContract({
		taskId: `R${index + 1}`,
		personaId: "reviewer",
		dependsOn: [],
		pathPolicy: { allowedGlobs: [`src/${index}/**`], forbiddenGlobs: [] },
	}));
	const harness = new DynamicHarness();
	const results = await harness.runToCompletion(contracts, {
		projectRoot,
		executor: async (contract) => {
			started.push(contract.taskId);
			await new Promise((resolve) => setTimeout(resolve, 10));
			return okResult(contract);
		},
		routePolicy: classifyRoutePolicy("audit dead code", { route: "audit_review", scale: "large" }),
	});
	expect(results).toHaveLength(4);
	// The exact event timing is implementation-dependent; pair this with event
	// assertions if the test helper exposes active-count snapshots.
});
```

- [x] **Step 2: Extend harness options**

In `src/orchestration/DagHarness.ts`:

```ts
import type { RoutePolicy } from "./RoutePolicy.js";

export interface DagHarnessOptions {
	// existing fields...
	routePolicy?: RoutePolicy;
}
```

- [x] **Step 3: Build persona caps from policy or registry**

In `DynamicHarness.ts`:

```ts
import { getPersona } from "../personas/PersonaRegistry.js";

function personaCapFor(personaId: string, options?: DagHarnessOptions): number {
	const policyCap = options?.routePolicy?.personaCaps[personaId as keyof typeof options.routePolicy.personaCaps];
	if (policyCap !== undefined) return policyCap;
	try {
		return getPersona(personaId as any).parallelism.maxConcurrent;
	} catch {
		return 2;
	}
}
```

Replace the hardcoded `personaCaps` object with a lookup inside `canLaunch`.

- [x] **Step 4: Make reviewer registry cap practical**

In `src/personas/PersonaRegistry.ts`, update reviewer:

```ts
parallelism: { soloPerWave: false, maxConcurrent: 2 },
```

Route policy can raise it to `3` for `audit_review large`.

- [x] **Step 5: Run dynamic harness tests**

Run:

```powershell
npm test -- tests/unit/dynamic-harness.test.ts
```

Expected: PASS.

---

### Task 8: Route-Aware Worker Budget And Context Caps

**Files:**
- Modify: `src/orchestration/ClientAdapters.ts`
- Modify: `src/orchestration/WorkerLoop.ts`
- Modify: `src/memory/governance/ContextPackBuilder.ts` if context pack generation needs policy budget.
- Test: `tests/unit/worker-loop.test.ts`

- [x] **Step 1: Preserve current token behavior**

Do not globally increase `maxTokens`. Keep `persona.maxTokens` as the completion token cap passed to the model. The fan-out improvement should come from narrower tasks and smaller context packs, not from larger coarse contexts.

- [x] **Step 2: Pass execution depth from route policy**

In `createWorkerExecutor`, when calling `workerLoop.runTask`, add:

```ts
executionDepth: opts.routePolicy?.executionDepthByPersona[contract.personaId],
```

Extend `WorkerExecutorOptions` to accept `routePolicy?: RoutePolicy`.

- [x] **Step 3: Keep `WorkerLoop` budget resolution as source of step limits**

`WorkerLoop` already resolves:

```ts
const budget = resolveExecutionBudget(input.persona.id, input.executionDepth);
const maxSteps = input.maxSteps ?? budget.maxSteps;
```

Do not pass `persona.maxSteps` unless a later route policy explicitly needs per-task overrides.

- [x] **Step 4: Apply context pack caps where packs are built**

When a context pack is built for a refined task, use:

```ts
maxTokens: routePolicy.granularityCaps.contextPackMaxTokens
```

Expected caps:

```text
small: 3000
medium: 5000
large: 6000
```

- [x] **Step 5: Run worker and context-pack tests**

Run:

```powershell
npm test -- tests/unit/worker-loop.test.ts tests/unit/context-pack-builder.test.ts
```

Expected: PASS.

---

### Task 9: Full Regression And Known Blockers

**Files:**
- No new source files unless tests expose type errors.

- [x] **Step 1: Run focused route/fanout suite**

Run:

```powershell
npm test -- tests/unit/route-policy.test.ts tests/unit/route-policy-validator.test.ts tests/unit/personas.test.ts tests/unit/dynamic-harness.test.ts tests/unit/mimo-pipeline.test.ts
```

Expected: PASS for the focused suite.

- [x] **Step 2: Run TUI smoke import**

Run:

```powershell
npx tsx -e "import('./tui/src/app.tsx').then(() => console.log('ok'))"
```

Expected: prints `ok`.

- [x] **Step 3: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: May fail because the current worktree already has unrelated type issues in files such as `src/bridge/PipelineBridge.ts`, `src/orchestration/DynamicHarness.ts`, and `src/orchestration/index.ts`. Do not fix unrelated issues unless the user asks; report them separately.

- [x] **Step 4: Handle existing test blocker**

Before relying on `tests/unit/pipeline-bridge.test.ts`, inspect and resolve the pre-existing conflict markers around the test file if the user explicitly allows that cleanup. Otherwise, keep route policy prompt injection covered by a new clean unit test.

---

## Self-Review

- Spec coverage: The plan covers explicit and automatic route selection, prompt soft constraints, the five audit-review rules, W0.5 coarse-task-risk diagnostics, docs dependency shape, runtime persona caps, and route-aware worker budgets/context caps.
- Placeholder scan: No task uses placeholder language. Each step names exact files, test commands, and implementation shape.
- Type consistency: The plan consistently uses `RoutePolicy`, `OrchestrationRoute`, `FanoutScale`, `RouteHint`, `route`, `scale`, `taskCaps`, `personaCaps`, `granularityCaps`, and `executionDepthByPersona`.
