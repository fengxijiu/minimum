import { describe, expect, it } from "vitest";
import {
	compileRefinement,
	refineDag,
	type RefinementEntry,
} from "../../src/orchestration/index.js";
import type { CoarseDag, TaskInputs } from "../../src/orchestration/index.js";

const baseInputs: TaskInputs = {
	userGoal: "image upload feature",
	artifacts: [],
	constraints: ["no new runtime deps"],
};

function mkDag(over: Partial<CoarseDag> = {}): CoarseDag {
	return {
		epicId: "image_upload",
		phases: [
			{
				id: "P2",
				name: "implementation",
				tasks: [
					{
						id: "T2-1",
						personaId: "code_executor",
						objective: "implement upload endpoint",
						parallelGroup: "backend",
						dependsOn: ["T0-1"],
						needsRefine: true,
					},
				],
			},
		],
		...over,
	};
}

describe("compileRefinement", () => {
	it("parses a valid refine block", () => {
		const text = `<refine>{"tasks":[
			{"taskId":"T2-1","allowedGlobs":["src/upload.ts"],"acceptance":["returns 201"],"contextPack":"# Context Pack"}
		]}</refine>`;
		const r = compileRefinement(text);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const e = r.entries.get("T2-1")!;
			expect(e.allowedGlobs).toEqual(["src/upload.ts"]);
			expect(e.acceptance).toEqual(["returns 201"]);
			expect(e.contextPack).toBe("# Context Pack");
		}
	});

	it("rejects a missing block", () => {
		const r = compileRefinement("nothing here");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("missing");
	});

	it("rejects invalid JSON", () => {
		const r = compileRefinement("<refine>{ broken }</refine>");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("invalid JSON");
	});

	it("rejects an entry without allowedGlobs", () => {
		const r = compileRefinement(`<refine>{"tasks":[{"taskId":"T2-1"}]}</refine>`);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("allowedGlobs");
	});

	it("accepts snake_case aliases", () => {
		const r = compileRefinement(
			`<refine>{"tasks":[{"id":"T2-1","allowed_globs":["a.ts"]}]}</refine>`,
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.entries.get("T2-1")!.allowedGlobs).toEqual(["a.ts"]);
	});

	it("rejects duplicate refine entries", () => {
		const r = compileRefinement(
			`<refine>{"tasks":[{"taskId":"T1","allowedGlobs":["a"]},{"taskId":"T1","allowedGlobs":["b"]}]}</refine>`,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("duplicate");
	});
});

describe("refineDag", () => {
	function refinement(entries: RefinementEntry[]): Map<string, RefinementEntry> {
		return new Map(entries.map((e) => [e.taskId, e]));
	}

	it("fills allowedGlobs for needs_refine tasks from the refinement", () => {
		const { contracts, errors } = refineDag(mkDag(), {
			inputs: baseInputs,
			refinement: refinement([
				{ taskId: "T2-1", allowedGlobs: ["src/upload.ts"], acceptance: ["ok"] },
			]),
		});
		expect(errors).toEqual([]);
		expect(contracts[0]!.pathPolicy.allowedGlobs).toEqual(["src/upload.ts"]);
		expect(contracts[0]!.acceptance).toEqual(["ok"]);
		expect(contracts[0]!.outputSchema).toBe("task_report");
	});

	it("errors when a needs_refine task lacks a refinement entry", () => {
		const { errors } = refineDag(mkDag(), {
			inputs: baseInputs,
			refinement: refinement([]),
		});
		expect(errors.some((e) => e.errors.some((m) => m.includes("needs_refine")))).toBe(true);
	});

	it("keeps coarse allowedGlobs for non-refine tasks", () => {
		const dag = mkDag({
			phases: [
				{
					id: "P2",
					name: "impl",
					tasks: [
						{
							id: "T2-1",
							personaId: "code_executor",
							objective: "implement upload",
							parallelGroup: "backend",
							dependsOn: [],
							needsRefine: false,
							allowedGlobs: ["src/fixed.ts"],
						},
					],
				},
			],
		});
		const { contracts, errors } = refineDag(dag, {
			inputs: baseInputs,
			refinement: refinement([]),
		});
		expect(errors).toEqual([]);
		expect(contracts[0]!.pathPolicy.allowedGlobs).toEqual(["src/fixed.ts"]);
	});

	it("forces read-only personas to empty allowedGlobs", () => {
		const dag = mkDag({
			phases: [
				{
					id: "P0",
					name: "perception",
					tasks: [
						{
							id: "T0-1",
							personaId: "vision",
							objective: "analyze the design mockup",
							parallelGroup: "perception",
							dependsOn: [],
							needsRefine: false,
							allowedGlobs: ["should/be/ignored.ts"],
						},
					],
				},
			],
		});
		const { contracts, errors } = refineDag(dag, {
			inputs: baseInputs,
			refinement: refinement([]),
		});
		expect(errors).toEqual([]);
		expect(contracts[0]!.pathPolicy.allowedGlobs).toEqual([]);
		expect(contracts[0]!.outputSchema).toBe("vision_report");
	});

	it("merges refinement constraints onto base constraints", () => {
		const { contracts } = refineDag(mkDag(), {
			inputs: baseInputs,
			refinement: refinement([
				{ taskId: "T2-1", allowedGlobs: ["src/upload.ts"], constraints: ["use zod"] },
			]),
		});
		expect(contracts[0]!.inputs.constraints).toEqual(["no new runtime deps", "use zod"]);
	});

	it("passes persisted contextPack paths into task inputs", () => {
		const { contracts } = refineDag(mkDag(), {
			inputs: baseInputs,
			refinement: refinement([
				{
					taskId: "T2-1",
					allowedGlobs: ["src/upload.ts"],
					contextPackPath: "/tmp/tasks/image_upload/context-packs/T2-1.md",
				},
			]),
		});
		expect(contracts[0]!.inputs.contextPack).toBe("/tmp/tasks/image_upload/context-packs/T2-1.md");
	});

	it("synthesizes acceptance when none is provided", () => {
		const { contracts } = refineDag(mkDag(), {
			inputs: baseInputs,
			refinement: refinement([{ taskId: "T2-1", allowedGlobs: ["src/upload.ts"] }]),
		});
		expect(contracts[0]!.acceptance[0]).toContain("implement upload endpoint");
	});

	it("surfaces glob conflicts within a parallelGroup", () => {
		const dag = mkDag({
			phases: [
				{
					id: "P2",
					name: "impl",
					tasks: [
						{ id: "T2-1", personaId: "code_executor", objective: "impl part a", parallelGroup: "backend", dependsOn: [], needsRefine: true },
						{ id: "T2-2", personaId: "code_executor", objective: "impl part b", parallelGroup: "backend", dependsOn: [], needsRefine: true },
					],
				},
			],
		});
		const { errors } = refineDag(dag, {
			inputs: baseInputs,
			refinement: refinement([
				{ taskId: "T2-1", allowedGlobs: ["src/shared.ts"], acceptance: ["a"] },
				{ taskId: "T2-2", allowedGlobs: ["src/shared.ts"], acceptance: ["b"] },
			]),
		});
		expect(errors.some((e) => e.taskId === "_glob_conflict")).toBe(true);
	});

	it("skips validation when validate=false", () => {
		const { errors } = refineDag(mkDag(), {
			inputs: baseInputs,
			refinement: refinement([]),
			validate: false,
		});
		// the needs_refine-without-entry error is assembly-level, still recorded
		expect(errors.every((e) => e.taskId !== "_glob_conflict")).toBe(true);
	});
});
