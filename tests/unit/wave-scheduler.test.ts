import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskContract } from "../../src/orchestration/index.js";
import {
	buildWaves,
	schedule,
	type WaveEvent,
	type WorkerExecutor,
} from "../../src/orchestration/index.js";

function mkContract(over: Partial<TaskContract> = {}): TaskContract {
	return {
		taskId: "T-wave-1",
		phase: "P0",
		epicId: "E",
		personaId: "code_executor",
		objective: "implement upload handler",
		inputs: { userGoal: "image upload", artifacts: [], constraints: [] },
		pathPolicy: { allowedGlobs: ["src/x.ts"], forbiddenGlobs: [] },
		acceptance: ["done"],
		nonGoals: ["do not modify unrelated files"],
		blockedCondition: "blocked if required wave context is missing",
		outputSchema: "task_report",
		parallelGroup: "g",
		dependsOn: [],
		abortOnConflict: false,
		...over,
	};
}

const OK_OUTPUT = `<task_report><status>ok</status></task_report>`;

function okExecutor(): WorkerExecutor {
	return { run: async () => OK_OUTPUT };
}

describe("schedule", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-scheduler-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("runs a single-wave single-task schedule and returns results", async () => {
		const contract = mkContract({ taskId: "T1" });
		const { waves } = buildWaves([contract], { validate: false });
		const results = await schedule(waves, {
			projectRoot: dir,
			executor: okExecutor(),
		});
		expect(results).toHaveLength(1);
		expect(results[0]!.taskId).toBe("T1");
		expect(results[0]!.status).toBe("ok");
	});

	it("executes waves in order (dependsOn chain)", async () => {
		const order: string[] = [];
		const executor: WorkerExecutor = {
			run: async (contract) => {
				order.push(contract.taskId);
				return OK_OUTPUT;
			},
		};
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] } });
		const b = mkContract({ taskId: "T2", dependsOn: ["T1"], pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] } });
		const c = mkContract({ taskId: "T3", dependsOn: ["T2"], pathPolicy: { allowedGlobs: ["c.ts"], forbiddenGlobs: [] } });
		const { waves } = buildWaves([a, b, c], { validate: false });
		await schedule(waves, { projectRoot: dir, executor });
		expect(order).toEqual(["T1", "T2", "T3"]);
	});

	it("emits wave_start, task_start, task_done, wave_complete, schedule_complete", async () => {
		const events: WaveEvent[] = [];
		const contract = mkContract({ taskId: "T1" });
		const { waves } = buildWaves([contract], { validate: false });
		await schedule(waves, {
			projectRoot: dir,
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
		});
		const types = events.map((e) => e.type);
		expect(types).toContain("wave_start");
		expect(types).toContain("task_start");
		expect(types).toContain("task_done");
		expect(types).toContain("wave_complete");
		expect(types).toContain("schedule_complete");
	});

	it("emits stage_pause when total tasks exceed largeDagThreshold", async () => {
		const events: WaveEvent[] = [];
		const contracts = Array.from({ length: 5 }, (_, i) =>
			mkContract({ taskId: `T${i + 1}`, parallelGroup: `g${i}`, pathPolicy: { allowedGlobs: [`f${i}.ts`], forbiddenGlobs: [] } }),
		);
		const { waves } = buildWaves(contracts, { validate: false });
		await schedule(waves, {
			projectRoot: dir,
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
			largeDagThreshold: 3,
		});
		expect(events.some((e) => e.type === "stage_pause")).toBe(true);
	});

	it("does not emit stage_pause when tasks are below threshold", async () => {
		const events: WaveEvent[] = [];
		const contract = mkContract({ taskId: "T1" });
		const { waves } = buildWaves([contract], { validate: false });
		await schedule(waves, {
			projectRoot: dir,
			executor: okExecutor(),
			onEvent: (e) => events.push(e),
			largeDagThreshold: 12,
		});
		expect(events.some((e) => e.type === "stage_pause")).toBe(false);
	});

	it("respects soloPerWave: only one runtime_debug task runs per wave", async () => {
		const started: string[] = [];
		const executor: WorkerExecutor = {
			run: async (contract) => {
				started.push(contract.taskId);
				return OK_OUTPUT;
			},
		};
		// runtime_debug has soloPerWave=true; give each a different parallelGroup to avoid glob conflicts
		const a = mkContract({
			taskId: "TR1",
			personaId: "runtime_debug",
			outputSchema: "debug_report",
			parallelGroup: "run-a",
			pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		});
		const b = mkContract({
			taskId: "TR2",
			personaId: "runtime_debug",
			outputSchema: "debug_report",
			parallelGroup: "run-b",
			pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		});
		// put both in the same wave by having them share no deps
		const { waves } = buildWaves([a, b], { validate: false });
		// They should be in the same wave (wave 0)
		expect(waves[0]!.tasks).toHaveLength(2);
		const results = await schedule(waves, { projectRoot: dir, executor });
		// soloPerWave means only 1 of the 2 test_runner tasks should run
		expect(started).toHaveLength(1);
		expect(results).toHaveLength(1);
	});

	it("respects maxConcurrent: caps simultaneous executions", async () => {
		let concurrent = 0;
		let maxSeen = 0;
		const executor: WorkerExecutor = {
			run: async () => {
				concurrent++;
				maxSeen = Math.max(maxSeen, concurrent);
				// simulate async work
				await new Promise((r) => setTimeout(r, 10));
				concurrent--;
				return OK_OUTPUT;
			},
		};
		// code_executor has maxConcurrent=2 per PersonaRegistry; create 6 tasks in the same wave
		const contracts = Array.from({ length: 6 }, (_, i) =>
			mkContract({
				taskId: `T${i + 1}`,
				parallelGroup: `g${i}`,
				pathPolicy: { allowedGlobs: [`f${i}.ts`], forbiddenGlobs: [] },
			}),
		);
		const { waves } = buildWaves(contracts, { validate: false });
		await schedule(waves, { projectRoot: dir, executor });
		expect(maxSeen).toBeLessThanOrEqual(2);
	});

	it("collects results from multiple waves", async () => {
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] } });
		const b = mkContract({ taskId: "T2", dependsOn: ["T1"], pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] } });
		const { waves } = buildWaves([a, b], { validate: false });
		const results = await schedule(waves, { projectRoot: dir, executor: okExecutor() });
		expect(results.map((r) => r.taskId).sort()).toEqual(["T1", "T2"]);
	});

	it("schedule_complete event contains all results", async () => {
		let finalResults: unknown[] = [];
		const contracts = [
			mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] } }),
			mkContract({ taskId: "T2", pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] } }),
		];
		const { waves } = buildWaves(contracts, { validate: false });
		await schedule(waves, {
			projectRoot: dir,
			executor: okExecutor(),
			onEvent: (e) => {
				if (e.type === "schedule_complete") finalResults = e.allResults;
			},
		});
		expect(finalResults).toHaveLength(2);
	});
});
