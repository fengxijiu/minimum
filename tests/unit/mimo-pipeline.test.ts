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
		expect(phases).toEqual(["W0", "W1", "W0.5", "W2/3", "W4"]);
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
});
