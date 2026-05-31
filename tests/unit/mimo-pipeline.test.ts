import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	runPipeline,
	type PipelineEvent,
	type PlannerBridge,
} from "../../src/orchestration/index.js";
import type { CoarseDag } from "../../src/orchestration/index.js";
import type { TaskResult, WorkerExecutor } from "../../src/orchestration/index.js";
import { listCandidates } from "../../src/memory/governance/index.js";

const OK = `<task_report><status>ok</status>done</task_report>`;

function okExecutor(): WorkerExecutor {
	return { run: async () => OK };
}

const DAG_JSON = JSON.stringify({
	epic: "image_upload",
	phases: [
		{
			id: "P0",
			name: "perception",
			tasks: [
				{ id: "T0-1", persona: "repo_scout", objective: "scan the repo layout", parallelGroup: "perception", dependsOn: [], needsRefine: false },
			],
		},
		{
			id: "P2",
			name: "implementation",
			tasks: [
				{ id: "T2-1", persona: "code_executor", objective: "implement the upload endpoint", parallelGroup: "backend", dependsOn: ["T0-1"], needsRefine: true },
			],
		},
	],
});

function stubPlanner(over: Partial<PlannerBridge> = {}): PlannerBridge {
	return {
		compile: async () => `<task_dag>${DAG_JSON}</task_dag>`,
		refine: async () =>
			`<refine>{"tasks":[{"taskId":"T2-1","allowedGlobs":["src/upload.ts"],"acceptance":["returns 201"]}]}</refine>`,
		checkMission: async () => `# W3.5 Loop Detection Report

## 1. Final Decision

Decision: APPROVED_TO_W4

Reason:

- Ready.
`,
		finalize: async () => `<finalize>{"memory_decisions":[]}</finalize>`,
		...over,
	};
}

describe("runPipeline", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-pipe-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("runs all phases end to end", async () => {
		const events: PipelineEvent[] = [];
		const result = await runPipeline("build an image upload page with a backend endpoint", {
			projectRoot: dir,
			planner: stubPlanner(),
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
		});
		expect(result.ok).toBe(true);
		const phases = events.filter((e) => e.type === "phase_start").map((e) => (e as any).phase);
		expect(phases).toEqual(["W0", "W1", "W0.5", "W2/3", "W3.5", "W4"]);
	});

	it("runs perception then implementation tasks", async () => {
		const ran: string[] = [];
		const executor: WorkerExecutor = {
			run: async (c) => {
				ran.push(c.taskId);
				return OK;
			},
		};
		await runPipeline("image upload backend", {
			projectRoot: dir,
			planner: stubPlanner(),
			executor,
		});
		expect(ran).toContain("T0-1"); // perception
		expect(ran).toContain("T2-1"); // implementation
		expect(ran.indexOf("T0-1")).toBeLessThan(ran.indexOf("T2-1"));
	});

	it("emits dag_compiled with the epic id and task count", async () => {
		const events: PipelineEvent[] = [];
		await runPipeline("image upload", {
			projectRoot: dir,
			planner: stubPlanner(),
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
		});
		const compiled = events.find((e) => e.type === "dag_compiled") as any;
		expect(compiled.epicId).toBe("image_upload");
		expect(compiled.taskCount).toBe(2);
	});

	it("fails cleanly when the master DAG cannot compile", async () => {
		const events: PipelineEvent[] = [];
		const result = await runPipeline("x", {
			projectRoot: dir,
			planner: stubPlanner({ compile: async () => "no dag block here" }),
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
		});
		expect(result.ok).toBe(false);
		expect(events.some((e) => e.type === "pipeline_error" && (e as any).phase === "W0")).toBe(true);
	});

	it("applies finalize memory decisions and clears staging", async () => {
		// worker emits a memory candidate so staging is non-empty
		const withMem: WorkerExecutor = {
			run: async () =>
				`<task_report><status>ok</status>done</task_report>\n<memory_candidate>\nscope: backend\nconfidence: high\nrelated_files:\n  - src/upload.ts\n\n## Finding\nUse multer.\n</memory_candidate>`,
		};
		const planner = stubPlanner({
			finalize: async (_r, candidates) => {
				const id = candidates[0] ? `${candidates[0].sourceTask}.${candidates[0].persona}` : "none";
				return `<finalize>{"memory_decisions":[{"candidateId":"${id}","action":"merge","target":"backend.md","section":"Upload","reason":"verified"}]}</finalize>`;
			},
		});
		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner,
			executor: withMem,
		});
		expect(result.ok).toBe(true);
		expect(result.finalize!.applied.length).toBeGreaterThan(0);
		// staging cleared (invariant #3)
		const remaining = await listCandidates(dir);
		expect(remaining).toEqual([]);
		// merged into canonical
		const written = fs.readFileSync(path.join(dir, ".minimum", "backend.md"), "utf-8");
		expect(written).toContain("Use multer.");
	});

	it("fails cleanly (no uncaught throw) when the DAG has an impl cycle", async () => {
		const cyclicDag = JSON.stringify({
			epic: "cyclic",
			phases: [
				{
					id: "P2",
					name: "impl",
					tasks: [
						{ id: "T-a", persona: "code_executor", objective: "implement part a", parallelGroup: "ga", dependsOn: ["T-b"], needsRefine: false, allowedGlobs: ["a.ts"] },
						{ id: "T-b", persona: "code_executor", objective: "implement part b", parallelGroup: "gb", dependsOn: ["T-a"], needsRefine: false, allowedGlobs: ["b.ts"] },
					],
				},
			],
		});
		const events: PipelineEvent[] = [];
		const result = await runPipeline("image upload", {
			projectRoot: dir,
			planner: stubPlanner({ compile: async () => `<task_dag>${cyclicDag}</task_dag>` }),
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
		});
		expect(result.ok).toBe(false);
		expect(events.some((e) => e.type === "pipeline_error" && (e as any).phase === "W2/3")).toBe(true);
	});

	it("continues with empty refinement when refine output is unusable", async () => {
		const dagNoRefine: CoarseDag = JSON.parse(DAG_JSON) as unknown as CoarseDag;
		expect(dagNoRefine).toBeDefined();
		const result = await runPipeline("image upload", {
			projectRoot: dir,
			planner: stubPlanner({ refine: async () => "garbage, no refine block" }),
			executor: okExecutor(),
		});
		// needs_refine task without globs → refine errors, but pipeline still completes
		expect(result.ok).toBe(true);
	});

	it("writes inline refine contextPack and passes its path to the worker", async () => {
		const contextPack = "# Context Pack: T2-1\n\n## Goal\nImplement upload.";
		const seenContextPacks = new Map<string, string | undefined>();
		const executor: WorkerExecutor = {
			run: async (contract) => {
				seenContextPacks.set(contract.taskId, contract.inputs.contextPack);
				return OK;
			},
		};
		const planner = stubPlanner({
			refine: async () =>
				`<refine>${JSON.stringify({
					tasks: [
						{
							taskId: "T2-1",
							allowedGlobs: ["src/upload.ts"],
							acceptance: ["returns 201"],
							contextPack,
						},
					],
				})}</refine>`,
		});

		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner,
			executor,
		});

		expect(result.ok).toBe(true);
		const contextPath = seenContextPacks.get("T2-1");
		expect(contextPath).toBeTruthy();
		expect(contextPath).toContain(path.join(".minimum", "tasks", "image_upload", "context-packs", "T2-1.md"));
		expect(fs.readFileSync(contextPath!, "utf-8")).toContain("Implement upload.");
	});

	it("loops W3.5 repair tasks back through W1/W0.5/W2/3 once", async () => {
		const ran: string[] = [];
		const executor: WorkerExecutor = {
			run: async (contract) => {
				ran.push(contract.taskId);
				return OK;
			},
		};
		let checks = 0;
		const planner = stubPlanner({
			refine: async (dag) => {
				const taskIds = dag.phases.flatMap((p) => p.tasks.map((t) => t.id));
				return `<refine>${JSON.stringify({
					tasks: taskIds
						.filter((id) => id === "T2-1" || id.startsWith("T3.5-"))
						.map((taskId) => ({
							taskId,
							allowedGlobs: [`src/${taskId}.ts`],
							acceptance: [`${taskId} done`],
						})),
				})}</refine>`;
			},
			checkMission: async () => {
				checks++;
				if (checks === 1) {
					return `# W3.5 Loop Detection Report

## 1. Final Decision

Decision: LOOP_BACK_TO_W1

Reason:

- One blocking gap remains.

## 7. Loop-Back Tasks for W1

### Task 1: Implement missing rejected-file handling

- Priority: P1
- Blocking: Yes
- Reason: Rejected files are not covered.
- Source issue: W3.5 found a missing path.
- Expected outcome: Rejected files produce a clear error.
- Suggested owner agent: code_executor
- Acceptance criteria:
  - Rejected files are handled.
`;
				}
				return `Decision: APPROVED_TO_W4`;
			},
		});
		const events: PipelineEvent[] = [];

		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner,
			executor,
			onEvent: (e) => events.push(e),
		});

		expect(result.ok).toBe(true);
		expect(checks).toBe(2);
		expect(ran).toContain("T3.5-1-1");
		const phases = events.filter((e) => e.type === "phase_start").map((e) => (e as any).phase);
		expect(phases).toEqual([
			"W0",
			"W1",
			"W0.5",
			"W2/3",
			"W3.5",
			"W1",
			"W0.5",
			"W2/3",
			"W3.5",
			"W4",
		]);
	});

	it("stops when W3.5 asks for another loop after the repair cap", async () => {
		const planner = stubPlanner({
			refine: async (dag) => {
				const taskIds = dag.phases.flatMap((p) => p.tasks.map((t) => t.id));
				return `<refine>${JSON.stringify({
					tasks: taskIds
						.filter((id) => id === "T2-1" || id.startsWith("T3.5-"))
						.map((taskId) => ({
							taskId,
							allowedGlobs: [`src/${taskId}.ts`],
							acceptance: [`${taskId} done`],
						})),
				})}</refine>`;
			},
			checkMission: async () => `# W3.5 Loop Detection Report

## 1. Final Decision

Decision: LOOP_BACK_TO_W1

Reason:

- Still incomplete.

## 7. Loop-Back Tasks for W1

### Task 1: Keep fixing missing path

- Priority: P1
- Blocking: Yes
- Reason: Still missing.
- Source issue: W3.5 found a missing path.
- Expected outcome: Missing path is fixed.
- Suggested owner agent: code_executor
- Acceptance criteria:
  - Missing path works.
`,
		});
		const events: PipelineEvent[] = [];

		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner,
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
		});

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/another loop-back/);
		expect(events.some((e) => e.type === "pipeline_error" && (e as any).phase === "W3.5")).toBe(true);
	});
});
