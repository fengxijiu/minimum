import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	runPipeline,
	type PipelineEvent,
	type PlannerBridge,
} from "../../src/orchestration/index.js";
import type { CoarseDag } from "../../src/orchestration/index.js";
import type { TaskResult, WorkerExecutor } from "../../src/orchestration/index.js";
import { listCandidates } from "../../src/memory/governance/index.js";
import type { ChoicePayload, ChoiceVerdict, ConfirmationGate } from "../../src/tools/choice/ConfirmationGate.js";

const OK = `<task_report><status>ok</status>done</task_report>`;
const OK_WITH_FILE_LIST = `<task_report><status>ok</status><file_list>
- src/upload.ts
</file_list>done</task_report>`;
const BLOCKED_CONTEXT = `<task_report><status>blocked</status>missing T0-1.file_list</task_report>`;

class ScriptedChoiceGate implements ConfirmationGate {
	payloads: ChoicePayload[] = [];
	constructor(private verdicts: ChoiceVerdict[] = [{ type: "pick", optionId: "continue_w23" }]) {}
	async ask(payload: ChoicePayload): Promise<ChoiceVerdict> {
		this.payloads.push(payload);
		return this.verdicts.shift() ?? { type: "pick", optionId: "continue_w23" };
	}
}

function continueGate(): ScriptedChoiceGate {
	return new ScriptedChoiceGate([{ type: "pick", optionId: "continue_w23" }]);
}

async function runMinimalPipeline(
	planner: PlannerBridge,
	onEvent: (e: PipelineEvent) => void,
) {
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-w0-"));
	const executor: WorkerExecutor = {
		async run() {
			return OK;
		},
	};
	return runPipeline("test request", { projectRoot, planner, executor, onEvent, choiceGate: continueGate() });
}

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
			`<refine>{"tasks":[{"taskId":"T2-1","allowedGlobs":["src/upload.ts"],"acceptance":["returns 201"],"blockedCondition":"blocked if T0-1.file_list is unavailable or incomplete"}]}</refine>`,
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
			choiceGate: continueGate(),
		});
		expect(result.ok).toBe(true);
		const phases = events.filter((e) => e.type === "phase_start").map((e) => (e as any).phase);
		expect(phases).toEqual(["W0", "W1", "W0.5", "W2/3", "W3.5", "W4"]);
		expect(fs.existsSync(path.join(dir, ".minimum", "tasks", "image_upload", "dag.json"))).toBe(true);
		expect(fs.existsSync(path.join(dir, ".minimum", "tasks", "image_upload", "refinements", "initial.json"))).toBe(true);
		expect(fs.existsSync(path.join(dir, ".minimum", "tasks", "image_upload", "contracts", "initial.json"))).toBe(true);
		expect(fs.existsSync(path.join(dir, ".minimum", "tasks", "image_upload", "mission-checks", "1.md"))).toBe(true);
		expect(fs.existsSync(path.join(dir, ".minimum", "tasks", "image_upload", "mission-checks", "1.json"))).toBe(true);
		const index = fs.readFileSync(path.join(dir, ".minimum", "index.json"), "utf-8");
		expect(index).toContain("pipeline_artifact");
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
			choiceGate: continueGate(),
		});
		expect(ran).toContain("T0-1"); // perception
		expect(ran).toContain("T2-1"); // implementation
		expect(ran.indexOf("T0-1")).toBeLessThan(ran.indexOf("T2-1"));
	});

	it("allows one same-contract downstream run when launchRequirements are missing", async () => {
		const ran: string[] = [];
		const events: PipelineEvent[] = [];
		const executor: WorkerExecutor = {
			run: async (contract) => {
				ran.push(contract.taskId);
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
							blockedCondition: "blocked if T0-1.file_list is unavailable or incomplete",
							launchRequirements: [
								{ sourceTaskId: "T0-1", artifact: "file_list", required: true },
							],
						},
					],
				})}</refine>`,
		});

		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner,
			executor,
			onEvent: (e) => events.push(e),
			choiceGate: continueGate(),
		});

		expect(result.ok).toBe(true);
		expect(ran.filter((id) => id === "T2-1")).toHaveLength(1);
		expect(events.some((e) => e.type === "gate_retry" && (e as any).taskId === "T2-1")).toBe(true);
	});

	it("defers a downstream task after its one context-gap retry still blocks", async () => {
		const ran: string[] = [];
		const events: PipelineEvent[] = [];
		const executor: WorkerExecutor = {
			run: async (contract) => {
				ran.push(contract.taskId);
				return contract.taskId === "T2-1" ? BLOCKED_CONTEXT : OK;
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
							blockedCondition: "blocked if T0-1.file_list is unavailable or incomplete",
							launchRequirements: [
								{ sourceTaskId: "T0-1", artifact: "file_list", required: true },
							],
						},
					],
				})}</refine>`,
		});

		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner,
			executor,
			onEvent: (e) => events.push(e),
			choiceGate: continueGate(),
		});

		expect(result.ok).toBe(true);
		expect(ran.filter((id) => id === "T2-1")).toHaveLength(1);
		expect(events.some((e) => e.type === "task_deferred" && (e as any).taskId === "T2-1")).toBe(true);
	});

	it("runs downstream normally when required W1 artifacts are available", async () => {
		const ran: string[] = [];
		const events: PipelineEvent[] = [];
		const executor: WorkerExecutor = {
			run: async (contract) => {
				ran.push(contract.taskId);
				return contract.taskId === "T0-1" ? OK_WITH_FILE_LIST : OK;
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
							blockedCondition: "blocked if T0-1.file_list is unavailable or incomplete",
							launchRequirements: [
								{ sourceTaskId: "T0-1", artifact: "file_list", required: true },
							],
						},
					],
				})}</refine>`,
		});

		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner,
			executor,
			onEvent: (e) => events.push(e),
			choiceGate: continueGate(),
		});

		expect(result.ok).toBe(true);
		expect(ran).toContain("T2-1");
		expect(events.some((e) => e.type === "gate_retry")).toBe(false);
	});

	it("asks for W0.5 DAG confirmation before W2/3 starts", async () => {
		const gate = continueGate();
		const events: PipelineEvent[] = [];
		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner: stubPlanner(),
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
			choiceGate: gate,
		});

		expect(result.ok).toBe(true);
		expect(gate.payloads).toHaveLength(1);
		// Question is a short decision point; the DAG detail moves to `context`.
		expect(gate.payloads[0]!.question).toContain("进入 W2/3");
		expect(gate.payloads[0]!.context).toContain("W0.5 DAG 确认");
		const confirmIndex = events.findIndex((e) => e.type === "dag_confirmation_requested");
		const w23Index = events.findIndex((e) => e.type === "phase_start" && (e as any).phase === "W2/3");
		expect(confirmIndex).toBeGreaterThan(-1);
		expect(w23Index).toBeGreaterThan(confirmIndex);
		expect(fs.existsSync(path.join(dir, ".minimum", "tasks", "image_upload", "confirmations", "initial.md"))).toBe(true);
	});

	it("reruns W0.5 refine once when the user chooses rerun_refine", async () => {
		const gate = new ScriptedChoiceGate([
			{ type: "pick", optionId: "rerun_refine" },
			{ type: "pick", optionId: "continue_w23" },
		]);
		const refine = vi.fn(async () =>
			`<refine>{"tasks":[{"taskId":"T2-1","allowedGlobs":["src/upload.ts"],"acceptance":["returns 201"],"blockedCondition":"blocked if T0-1.file_list is unavailable or incomplete"}]}</refine>`);
		const planner = stubPlanner({ refine });
		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner,
			executor: okExecutor(),
			choiceGate: gate,
		});

		expect(result.ok).toBe(true);
		expect(refine).toHaveBeenCalledTimes(2);
		expect(refine.mock.calls[1]![3]).toContain("rerun_refine");
		expect(gate.payloads).toHaveLength(2);
		expect(fs.existsSync(path.join(dir, ".minimum", "tasks", "image_upload", "confirmations", "initial-refine-retry.md"))).toBe(true);
	});

	it("stops gracefully when W0.5 confirmation is cancelled", async () => {
		const events: PipelineEvent[] = [];
		const gate = new ScriptedChoiceGate([{ type: "cancel" }]);
		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner: stubPlanner(),
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
			choiceGate: gate,
		});

		expect(result.ok).toBe(false);
		expect(result.statusReason).toBe("human_confirmation");
		expect(events.some((e) => e.type === "human_confirmation_required" && (e as any).phase === "W0.5")).toBe(true);
		expect(events.some((e) => e.type === "pipeline_error")).toBe(false);
		expect(events.some((e) => e.type === "phase_start" && (e as any).phase === "W2/3")).toBe(false);
	});

	it("retries W3.5 once after an invalid mission report when the user chooses retry_w35", async () => {
		const events: PipelineEvent[] = [];
		const gate = new ScriptedChoiceGate([
			{ type: "pick", optionId: "continue_w23" },
			{ type: "pick", optionId: "retry_w35" },
		]);
		const checkMission = vi.fn(async (_input, feedback?: string) => {
			if (!feedback) return "missing a legal decision";
			return "Decision: APPROVED_TO_W4";
		});
		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner: stubPlanner({ checkMission }),
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
			choiceGate: gate,
		});

		expect(result.ok).toBe(true);
		expect(checkMission).toHaveBeenCalledTimes(2);
		expect(checkMission.mock.calls[1]![1]).toContain("mission check report must include Decision");
		expect(events.some((e) => e.type === "mission_parse_failed")).toBe(true);
		expect(events.some((e) => e.type === "pipeline_error" && (e as any).phase === "W3.5")).toBe(false);
	});

	it("stops gracefully after W3.5 parse failure when the user chooses human confirmation", async () => {
		const events: PipelineEvent[] = [];
		const gate = new ScriptedChoiceGate([
			{ type: "pick", optionId: "continue_w23" },
			{ type: "pick", optionId: "needs_human_confirmation" },
		]);
		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner: stubPlanner({ checkMission: async () => "missing a legal decision" }),
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
			choiceGate: gate,
		});

		expect(result.ok).toBe(false);
		expect(result.statusReason).toBe("human_confirmation");
		expect(events.some((e) => e.type === "mission_parse_failed")).toBe(true);
		expect(events.some((e) => e.type === "pipeline_error")).toBe(false);
	});

	it("treats unusable W3.5 loop-back task contracts as mission parse failures", async () => {
		const events: PipelineEvent[] = [];
		const gate = new ScriptedChoiceGate([
			{ type: "pick", optionId: "continue_w23" },
			{ type: "pick", optionId: "needs_human_confirmation" },
		]);
		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner: stubPlanner({
				checkMission: async () => `# W3.5 Loop Detection Report

Decision: LOOP_BACK_TO_W1

Reason:

- Missing rejected-file handling.

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
`,
			}),
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
			choiceGate: gate,
		});

		expect(result.ok).toBe(false);
		expect(result.statusReason).toBe("human_confirmation");
		expect(events.some((e) => e.type === "mission_parse_failed" && (e as any).error.includes("usable contracts"))).toBe(true);
		expect(fs.existsSync(path.join(dir, ".minimum", "tasks", "image_upload", "repair-dags", "1.json"))).toBe(false);
	});

	it("asks for confirmation and stops gracefully when the mission repair cap is reached", async () => {
		const events: PipelineEvent[] = [];
		const loopBackReport = `# W3.5 Loop Detection Report

Decision: LOOP_BACK_TO_W1

Reason:

- Still missing rejected-file handling.

## 7. Loop-Back Tasks for W1

### Task 1: Patch upload rejection branch

- Priority: P1
- Blocking: Yes
- Reason: Rejected files are silently dropped.
- Source issue: W3.5 detected missing branch.
- Expected outcome: Rejected files return a clear error.
- Suggested owner agent: code_executor
- Allowed globs:
  - src/upload-rejected.ts
- Acceptance criteria:
  - Rejected files produce a clear error.
`;
		const gate = new ScriptedChoiceGate([
			{ type: "pick", optionId: "continue_w23" }, // initial W0.5 DAG gate
			{ type: "pick", optionId: "continue_w23" }, // repair-1 W0.5 DAG gate
			{ type: "pick", optionId: "stop_for_human" }, // mission repair cap gate
		]);
		const checkMission = vi.fn(async () => loopBackReport);
		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner: stubPlanner({ checkMission }),
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
			choiceGate: gate,
		});

		expect(result.ok).toBe(false);
		expect(result.statusReason).toBe("human_confirmation");
		expect(checkMission).toHaveBeenCalledTimes(2);
		expect(events.some((e) => e.type === "pipeline_error")).toBe(false);
		expect(events.some((e) => e.type === "human_confirmation_required" && (e as any).phase === "W3.5")).toBe(true);
		const capPayload = gate.payloads[gate.payloads.length - 1]!;
		expect(capPayload.options.map((o) => o.id).sort()).toEqual(
			["approve_to_w4", "continue_repair", "stop_for_human"].sort(),
		);
	});

	it("advances to W4 when the user approves override at the mission repair cap", async () => {
		const events: PipelineEvent[] = [];
		const loopBackReport = `# W3.5 Loop Detection Report

Decision: LOOP_BACK_TO_W1

Reason:

- Still missing rejected-file handling.

## 7. Loop-Back Tasks for W1

### Task 1: Patch upload rejection branch

- Priority: P1
- Blocking: Yes
- Reason: Rejected files are silently dropped.
- Source issue: W3.5 detected missing branch.
- Expected outcome: Rejected files return a clear error.
- Suggested owner agent: code_executor
- Allowed globs:
  - src/upload-rejected.ts
- Acceptance criteria:
  - Rejected files produce a clear error.
`;
		const gate = new ScriptedChoiceGate([
			{ type: "pick", optionId: "continue_w23" },
			{ type: "pick", optionId: "continue_w23" },
			{ type: "pick", optionId: "approve_to_w4" },
		]);
		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner: stubPlanner({ checkMission: async () => loopBackReport }),
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
			choiceGate: gate,
		});

		expect(result.ok).toBe(true);
		expect(result.statusReason).toBe("user_override");
		expect(events.some((e) => e.type === "pipeline_choice" && (e as any).phase === "W3.5" && (e as any).choiceId === "approve_to_w4")).toBe(true);
		expect(events.some((e) => e.type === "phase_start" && (e as any).phase === "W4")).toBe(true);
	});

	it("continues to W4 after W3.5 parse failure when the user explicitly approves override", async () => {
		const events: PipelineEvent[] = [];
		const gate = new ScriptedChoiceGate([
			{ type: "pick", optionId: "continue_w23" },
			{ type: "pick", optionId: "approve_to_w4" },
		]);
		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner: stubPlanner({ checkMission: async () => "missing a legal decision" }),
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
			choiceGate: gate,
		});

		expect(result.ok).toBe(true);
		expect(result.statusReason).toBe("user_override");
		expect(events.some((e) => e.type === "pipeline_choice" && (e as any).choiceId === "approve_to_w4")).toBe(true);
		expect(events.some((e) => e.type === "phase_start" && (e as any).phase === "W4")).toBe(true);
	});

	it("emits dag_compiled with the epic id and task count", async () => {
		const events: PipelineEvent[] = [];
		await runPipeline("image upload", {
			projectRoot: dir,
			planner: stubPlanner(),
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
			choiceGate: continueGate(),
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
			choiceGate: continueGate(),
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
			choiceGate: continueGate(),
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
			choiceGate: continueGate(),
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
			choiceGate: continueGate(),
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
			choiceGate: continueGate(),
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
- Allowed globs:
  - src/T3.5-1-1.ts
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
			choiceGate: continueGate(),
		});

		expect(result.ok).toBe(true);
		expect(checks).toBe(2);
		expect(ran).toContain("T3.5-1-1");
		expect(fs.existsSync(path.join(dir, ".minimum", "tasks", "image_upload", "repair-dags", "1.json"))).toBe(true);
		expect(fs.existsSync(path.join(dir, ".minimum", "tasks", "image_upload", "contracts", "repair-1.json"))).toBe(true);
		expect(fs.existsSync(path.join(dir, ".minimum", "tasks", "image_upload", "mission-checks", "2.md"))).toBe(true);
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
- Allowed globs:
  - src/T3.5-1-1.ts
- Acceptance criteria:
  - Missing path works.
`,
		});
		const events: PipelineEvent[] = [];

		const gate = new ScriptedChoiceGate([
			{ type: "pick", optionId: "continue_w23" }, // initial W0.5 DAG gate
			{ type: "pick", optionId: "continue_w23" }, // repair-1 W0.5 DAG gate
			{ type: "pick", optionId: "stop_for_human" }, // mission repair cap gate
		]);
		const result = await runPipeline("image upload backend", {
			projectRoot: dir,
			planner,
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
			choiceGate: gate,
		});

		expect(result.ok).toBe(false);
		expect(result.statusReason).toBe("human_confirmation");
		expect(events.some((e) => e.type === "human_confirmation_required" && (e as any).phase === "W3.5")).toBe(true);
		expect(events.some((e) => e.type === "pipeline_error")).toBe(false);
	});
});

describe("MiMoPipeline W0 compile retry", () => {
	const validDagText = `<task_dag>
{ "epic": "e", "phases": [ { "id": "P0", "name": "p", "tasks": [
  { "id": "T0-1", "persona": "vision", "objective": "scan the repo",
    "parallelGroup": "g", "dependsOn": [], "needsRefine": false } ] } ] }
</task_dag>`;

	const invalidDagText = `<task_dag>
{ "epic": "e", "phases": [ { "id": "P0", "name": "p", "tasks": [
  { "id": "T0-1", "persona": "developer", "objective": "scan the repo",
    "parallelGroup": "g", "dependsOn": [], "needsRefine": false } ] } ] }
</task_dag>`;

	function mkPlanner(outputs: string[]): PlannerBridge {
		const compile = vi.fn(async (_r: string, _m: string, _f?: string) => outputs.shift() ?? "");
		return {
			compile,
			refine: vi.fn(async () => `<refine>{"tasks":[]}</refine>`),
			checkMission: vi.fn(async () => "Decision: APPROVED_TO_W4"),
			finalize: vi.fn(async () => `<finalize>{"memory_decisions":[]}</finalize>`),
		};
	}

	it("retries once and succeeds when planner self-corrects", async () => {
		const events: PipelineEvent[] = [];
		const planner = mkPlanner([invalidDagText, validDagText]);
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
		const planner = mkPlanner([invalidDagText, invalidDagText]);
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
