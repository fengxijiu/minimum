import { describe, expect, it } from "vitest";
import {
	findDanglingDeps,
	findGlobConflicts,
	validateContract,
} from "../../src/orchestration/index.js";
import type { TaskContract } from "../../src/orchestration/TaskContract.js";

function makeContract(overrides: Partial<TaskContract> = {}): TaskContract {
	return {
		taskId: "T-A1-1",
		phase: "P1-frontend",
		epicId: "image_upload",
		personaId: "code_executor",
		objective: "implement upload component",
		inputs: {
			userGoal: "image upload page",
			artifacts: [],
			constraints: [],
		},
		pathPolicy: {
			allowedGlobs: ["frontend/src/components/Upload.tsx"],
			forbiddenGlobs: [],
		},
		acceptance: ["component renders without errors"],
		outputSchema: "task_report",
		parallelGroup: "frontend",
		dependsOn: [],
		abortOnConflict: false,
		...overrides,
	};
}

describe("validateContract", () => {
	it("accepts a minimal valid contract", () => {
		const r = validateContract(makeContract());
		expect(r.ok).toBe(true);
		expect(r.errors).toEqual([]);
	});

	describe("required fields", () => {
		const required = [
			["taskId", { taskId: "" }],
			["epicId", { epicId: "" }],
			["phase", { phase: "" }],
			["parallelGroup", { parallelGroup: "" }],
			["personaId", { personaId: "" as never }],
			["outputSchema", { outputSchema: undefined as never }],
		] as const;

		for (const [field, override] of required) {
			it(`rejects missing ${field}`, () => {
				const r = validateContract(makeContract(override as Partial<TaskContract>));
				expect(r.ok).toBe(false);
				expect(r.errors.some((e) => e.includes(field))).toBe(true);
			});
		}
	});

	it("rejects taskId with invalid pattern", () => {
		const r = validateContract(makeContract({ taskId: "no_prefix" }));
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => e.includes("taskId"))).toBe(true);
	});

	it("accepts standard taskId patterns", () => {
		for (const id of ["T1", "T-A1-1", "T_C2_3", "T-foo.bar"]) {
			expect(validateContract(makeContract({ taskId: id })).ok).toBe(true);
		}
	});

	it("rejects objective shorter than 8 chars", () => {
		const r = validateContract(makeContract({ objective: "short" }));
		expect(r.ok).toBe(false);
	});

	it("rejects empty acceptance", () => {
		const r = validateContract(makeContract({ acceptance: [] }));
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => e.includes("acceptance"))).toBe(true);
	});

	it("rejects non-array dependsOn", () => {
		const r = validateContract(
			makeContract({ dependsOn: "T1" as unknown as string[] }),
		);
		expect(r.ok).toBe(false);
	});

	describe("path policy", () => {
		it("rejects allowedGlobs on a read-only persona", () => {
			const r = validateContract(
				makeContract({
					personaId: "reviewer",
					outputSchema: "review_report",
					pathPolicy: { allowedGlobs: ["src/foo.ts"], forbiddenGlobs: [] },
				}),
			);
			expect(r.ok).toBe(false);
			expect(r.errors.some((e) => e.includes("read-only"))).toBe(true);
		});

		it("accepts empty allowedGlobs on a read-only persona", () => {
			const r = validateContract(
				makeContract({
					personaId: "reviewer",
					outputSchema: "review_report",
					pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
				}),
			);
			expect(r.ok).toBe(true);
		});

		it("rejects code_executor without contract-level allowedGlobs", () => {
			const r = validateContract(
				makeContract({
					pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
				}),
			);
			expect(r.ok).toBe(false);
			expect(r.errors.some((e) => e.includes("requires allowedGlobs"))).toBe(true);
		});

		it("accepts test_writer without contract-level allowedGlobs", () => {
			// test_writer has alwaysAllowedGlobs covering tests/**
			const r = validateContract(
				makeContract({
					personaId: "test_writer",
					outputSchema: "test_report",
					pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
				}),
			);
			expect(r.ok).toBe(true);
		});
	});

	describe("persona/output schema compatibility", () => {
		it("rejects outputSchema that does not match persona", () => {
			const r = validateContract(
				makeContract({
					personaId: "reviewer",
					outputSchema: "task_report", // reviewer expects review_report
					pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
				}),
			);
			expect(r.ok).toBe(false);
			expect(r.errors.some((e) => e.includes("does not match persona"))).toBe(true);
		});
	});
});

describe("findGlobConflicts", () => {
	it("returns empty when groups are disjoint", () => {
		const a = makeContract({
			taskId: "T1",
			parallelGroup: "g1",
			pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] },
		});
		const b = makeContract({
			taskId: "T2",
			parallelGroup: "g1",
			pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] },
		});
		expect(findGlobConflicts([a, b])).toEqual([]);
	});

	it("detects shared globs in the same group", () => {
		const a = makeContract({
			taskId: "T1",
			parallelGroup: "g1",
			pathPolicy: { allowedGlobs: ["shared.ts"], forbiddenGlobs: [] },
		});
		const b = makeContract({
			taskId: "T2",
			parallelGroup: "g1",
			pathPolicy: { allowedGlobs: ["shared.ts"], forbiddenGlobs: [] },
		});
		const conflicts = findGlobConflicts([a, b]);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({ taskA: "T1", taskB: "T2", glob: "shared.ts" });
	});

	it("does not flag the same glob across different groups", () => {
		const a = makeContract({
			taskId: "T1",
			parallelGroup: "g1",
			pathPolicy: { allowedGlobs: ["x.ts"], forbiddenGlobs: [] },
		});
		const b = makeContract({
			taskId: "T2",
			parallelGroup: "g2",
			pathPolicy: { allowedGlobs: ["x.ts"], forbiddenGlobs: [] },
		});
		expect(findGlobConflicts([a, b])).toEqual([]);
	});
});

describe("findDanglingDeps", () => {
	it("returns empty when all deps resolve", () => {
		const a = makeContract({ taskId: "T1" });
		const b = makeContract({ taskId: "T2", dependsOn: ["T1"] });
		expect(findDanglingDeps([a, b])).toEqual([]);
	});

	it("reports unknown deps", () => {
		const a = makeContract({ taskId: "T2", dependsOn: ["T-missing"] });
		expect(findDanglingDeps([a])).toEqual([
			{ taskId: "T2", missingDep: "T-missing" },
		]);
	});
});
