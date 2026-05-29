import { describe, expect, it } from "vitest";
import {
	buildWaves,
	classifyTaskType,
	compileCoarse,
	partitionByParallelGroup,
} from "../../src/orchestration/index.js";
import type { TaskContract } from "../../src/orchestration/index.js";

function mkContract(over: Partial<TaskContract> = {}): TaskContract {
	return {
		taskId: "T-1",
		phase: "P0",
		epicId: "E",
		personaId: "code_executor",
		objective: "implement upload",
		inputs: { userGoal: "image upload", artifacts: [], constraints: [] },
		pathPolicy: { allowedGlobs: ["src/x.ts"], forbiddenGlobs: [] },
		acceptance: ["a"],
		outputSchema: "task_report",
		parallelGroup: "g",
		dependsOn: [],
		abortOnConflict: false,
		...over,
	};
}

describe("compileCoarse", () => {
	const validDag = `
<task_dag>
{
  "epic": "image_upload",
  "phases": [
    { "id": "P0", "name": "perception",
      "tasks": [
        { "id": "T0-1", "persona": "vision",
          "objective": "analyze design",
          "parallelGroup": "perception",
          "dependsOn": [], "needsRefine": false }
      ]
    }
  ]
}
</task_dag>
`;

	it("parses a valid task_dag block", () => {
		const r = compileCoarse(validDag);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.dag.epicId).toBe("image_upload");
			expect(r.dag.phases[0]!.tasks[0]!.personaId).toBe("vision");
		}
	});

	it("rejects missing block", () => {
		const r = compileCoarse("no tag here");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("missing");
	});

	it("rejects invalid JSON", () => {
		const r = compileCoarse("<task_dag>{ broken }</task_dag>");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("invalid JSON");
	});

	it("rejects unknown persona", () => {
		const bad = validDag.replace('"vision"', '"ghost"');
		const r = compileCoarse(bad);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("persona");
	});

	it("rejects duplicate task ids", () => {
		const dup = `<task_dag>{"epic":"E","phases":[
      {"id":"P","name":"p","tasks":[
        {"id":"T1","persona":"vision","objective":"analyze","parallelGroup":"g","dependsOn":[]},
        {"id":"T1","persona":"vision","objective":"analyze","parallelGroup":"g","dependsOn":[]}
      ]}
    ]}</task_dag>`;
		const r = compileCoarse(dup);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("duplicate");
	});

	it("accepts snake_case field aliases", () => {
		const snake = `<task_dag>{"epic":"E","phases":[
      {"id":"P","name":"p","tasks":[
        {"id":"T1","role":"vision","objective":"analyze design","parallel_group":"g","depends_on":[],"needs_refine":true}
      ]}
    ]}</task_dag>`;
		const r = compileCoarse(snake);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.dag.phases[0]!.tasks[0]!.needsRefine).toBe(true);
		}
	});
});

describe("classifyTaskType", () => {
	it("classifies frontend tasks", () => {
		expect(classifyTaskType("design a Tailwind upload component")).toBe(
			"frontend",
		);
	});
	it("classifies backend tasks", () => {
		expect(classifyTaskType("add an API endpoint for FastAPI")).toBe("backend");
	});
	it("classifies debugging tasks", () => {
		expect(classifyTaskType("fix the failing test crash")).toBe("debugging");
	});
	it("classifies mixed tasks", () => {
		expect(classifyTaskType("implement upload page with backend endpoint")).toBe(
			"mixed",
		);
	});
	it("defaults to mixed when ambiguous", () => {
		expect(classifyTaskType("refactor things")).toBe("mixed");
	});
});

describe("buildWaves", () => {
	it("schedules independent tasks in wave 0", () => {
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] } });
		const b = mkContract({ taskId: "T2", pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] } });
		const { waves, errors } = buildWaves([a, b]);
		expect(errors).toEqual([]);
		expect(waves).toHaveLength(1);
		expect(waves[0]!.tasks.map((t) => t.taskId).sort()).toEqual(["T1", "T2"]);
	});

	it("respects dependsOn ordering", () => {
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] } });
		const b = mkContract({ taskId: "T2", dependsOn: ["T1"], pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] } });
		const c = mkContract({ taskId: "T3", dependsOn: ["T2"], pathPolicy: { allowedGlobs: ["c.ts"], forbiddenGlobs: [] } });
		const { waves } = buildWaves([c, b, a]); // intentionally unsorted input
		expect(waves.map((w) => w.tasks.map((t) => t.taskId))).toEqual([
			["T1"], ["T2"], ["T3"],
		]);
	});

	it("throws on cycle", () => {
		const a = mkContract({ taskId: "T1", dependsOn: ["T2"], pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] } });
		const b = mkContract({ taskId: "T2", dependsOn: ["T1"], pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] } });
		expect(() => buildWaves([a, b])).toThrow(/cycle/);
	});

	it("surfaces validation errors", () => {
		const bad = mkContract({ objective: "x" }); // too short
		const { waves, errors } = buildWaves([bad]);
		expect(waves).toHaveLength(1);
		expect(errors.length).toBeGreaterThan(0);
	});

	it("surfaces glob conflicts in same group", () => {
		const a = mkContract({
			taskId: "T1",
			parallelGroup: "g1",
			pathPolicy: { allowedGlobs: ["shared.ts"], forbiddenGlobs: [] },
		});
		const b = mkContract({
			taskId: "T2",
			parallelGroup: "g1",
			pathPolicy: { allowedGlobs: ["shared.ts"], forbiddenGlobs: [] },
		});
		const { errors } = buildWaves([a, b]);
		expect(errors.some((e) => e.taskId === "_glob_conflict")).toBe(true);
	});

	it("skips validation when validate=false", () => {
		const bad = mkContract({ objective: "x" });
		const { errors } = buildWaves([bad], { validate: false });
		expect(errors).toEqual([]);
	});

	it("surfaces dangling dependencies", () => {
		const a = mkContract({
			taskId: "T1",
			dependsOn: ["T-missing"],
			pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] },
		});
		const { errors } = buildWaves([a]);
		const dangling = errors.find((e) => e.taskId === "_dangling_dep");
		expect(dangling).toBeDefined();
		expect(dangling!.errors[0]).toContain("T-missing");
	});
});

describe("partitionByParallelGroup", () => {
	it("groups tasks within a wave by parallelGroup", () => {
		const a = mkContract({ taskId: "T1", parallelGroup: "frontend" });
		const b = mkContract({ taskId: "T2", parallelGroup: "backend" });
		const c = mkContract({ taskId: "T3", parallelGroup: "frontend" });
		const groups = partitionByParallelGroup({ waveIndex: 0, tasks: [a, b, c] });
		expect(groups.get("frontend")!.map((t) => t.taskId)).toEqual(["T1", "T3"]);
		expect(groups.get("backend")!.map((t) => t.taskId)).toEqual(["T2"]);
	});
});
