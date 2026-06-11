import { describe, expect, it } from "vitest";
import { TaskGraphIndex } from "../../src/orchestration/TaskGraphIndex.js";
import type { TaskContract } from "../../src/orchestration/TaskContract.js";

function mkContract(over: Partial<TaskContract> = {}): TaskContract {
	return {
		taskId: "T",
		phase: "P0",
		epicId: "E",
		personaId: "code_executor",
		objective: "do work",
		inputs: { userGoal: "g", artifacts: [], constraints: [] },
		pathPolicy: { allowedGlobs: ["src/x.ts"], forbiddenGlobs: [] },
		acceptance: ["done"],
		nonGoals: [],
		blockedCondition: "blocked if context missing",
		outputSchema: "task_report",
		parallelGroup: "g",
		dependsOn: [],
		grantedSkills: [],
		grantedMcpTools: [],
		abortOnConflict: false,
		...over,
	};
}

describe("TaskGraphIndex — degraded handling (#8)", () => {
	it("does not report a degraded upstream as an unresolved dependency", () => {
		const a = mkContract({ taskId: "A" });
		const b = mkContract({ taskId: "B", dependsOn: ["A"] });
		const idx = new TaskGraphIndex([a, b]);

		// A finishes degraded and unlocks B.
		idx.tryUnlock("A", "degraded");
		idx.setStatus("B", "ready");

		const diags = idx.buildIdleDiagnostics();
		const bDiag = diags.find((d) => d.taskId === "B");
		// B is ready; it must NOT be described as waiting on the degraded upstream A.
		expect(bDiag?.reason ?? "").not.toContain("A(degraded)");
	});
});

describe("TaskGraphIndex — blocked nodes reach a terminal state (#2)", () => {
	it("skips a blocked node once all its upstreams are terminal and one failed", () => {
		// D depends on B and C. B fails first → D has a pending upstream (C) so it is
		// marked blocked rather than skipped. When C later fails, D must transition
		// from blocked to skipped instead of latching forever.
		const b = mkContract({ taskId: "B" });
		const c = mkContract({ taskId: "C" });
		const d = mkContract({ taskId: "D", dependsOn: ["B", "C"] });
		const idx = new TaskGraphIndex([b, c, d]);

		idx.propagateFailure("B");
		expect(idx.getStatus("D")).toBe("blocked");

		const skipped = idx.propagateFailure("C");
		expect(skipped).toContain("D");
		expect(idx.getStatus("D")).toBe("skipped");
	});

	it("reports isComplete once every task is terminal including degraded", () => {
		const a = mkContract({ taskId: "A" });
		const b = mkContract({ taskId: "B", dependsOn: ["A"] });
		const idx = new TaskGraphIndex([a, b]);
		idx.tryUnlock("A", "degraded");
		idx.setStatus("B", "ok");
		expect(idx.isComplete).toBe(true);
	});
});
