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
			{"taskId":"T2-1","allowedGlobs":["src/upload.ts"],"acceptance":["returns 201"],"blockedCondition":"blocked if T0-1.file_list is unavailable or incomplete","launchRequirements":[{"sourceTaskId":"T0-1","artifact":"file_list","required":true}],"contextPack":"# Context Pack"}
		]}</refine>`;
		const r = compileRefinement(text);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const e = r.entries.get("T2-1")!;
			expect(e.allowedGlobs).toEqual(["src/upload.ts"]);
			expect(e.acceptance).toEqual(["returns 201"]);
			expect(e.blockedCondition).toContain("T0-1.file_list");
			expect(e.launchRequirements).toEqual([
				{ sourceTaskId: "T0-1", artifact: "file_list", required: true },
			]);
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

	it("rejects invalid launchRequirements", () => {
		const r = compileRefinement(
			`<refine>{"tasks":[{"taskId":"T2-1","allowedGlobs":["a.ts"],"launchRequirements":[{"sourceTaskId":"T0-1","artifact":"unknown"}]}]}</refine>`,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("launchRequirements");
	});

	it("accepts static_compile_commands in launchRequirements", () => {
		const r = compileRefinement(
			`<refine>{"tasks":[{"taskId":"T2-1","allowedGlobs":["a.ts"],"launchRequirements":[{"sourceTaskId":"T0-1","artifact":"static_compile_commands","required":true}]}]}</refine>`,
		);
		expect(r.ok).toBe(true);
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
				{
					taskId: "T2-1",
					allowedGlobs: ["src/upload.ts"],
					acceptance: ["ok"],
					blockedCondition: "blocked if T0-1.file_list is unavailable or incomplete",
					launchRequirements: [{ sourceTaskId: "T0-1", artifact: "file_list", required: true }],
				},
			]),
		});
		expect(errors).toEqual([]);
		expect(contracts[0]!.pathPolicy.allowedGlobs).toEqual(["src/upload.ts"]);
		expect(contracts[0]!.acceptance).toEqual(["ok"]);
		expect(contracts[0]!.launchRequirements).toEqual([
			{ sourceTaskId: "T0-1", artifact: "file_list", required: true },
		]);
		expect(contracts[0]!.outputSchema).toBe("task_report");
	});

	it("rejects write-capable needs_refine tasks without an explicit blockedCondition", () => {
		const { errors } = refineDag(mkDag(), {
			inputs: baseInputs,
			refinement: refinement([
				{ taskId: "T2-1", allowedGlobs: ["src/upload.ts"], acceptance: ["ok"] },
			]),
		});
		expect(errors.some((e) => e.taskId === "T2-1" && e.errors.some((m) => m.includes("blockedCondition")))).toBe(true);
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
		expect(contracts[0]!.outputSchema).toBe("task_report");
	});

	it("merges refinement constraints onto base constraints", () => {
		const { contracts } = refineDag(mkDag(), {
			inputs: { ...baseInputs, staticCompileCommands: ["npm run typecheck"] },
			refinement: refinement([
				{ taskId: "T2-1", allowedGlobs: ["src/upload.ts"], constraints: ["use zod"] },
			]),
		});
		expect(contracts[0]!.inputs.constraints).toEqual(["no new runtime deps", "use zod"]);
		expect(contracts[0]!.inputs.staticCompileCommands).toEqual(["npm run typecheck"]);
		expect(contracts[0]!.postStaticCompile).toEqual({
			required: true,
			commands: ["npm run typecheck"],
		});
	});

	it("does NOT enable postStaticCompile for a write task that only writes markdown", () => {
		const { contracts } = refineDag(mkDag(), {
			inputs: { ...baseInputs, staticCompileCommands: ["npm run typecheck"] },
			refinement: refinement([
				{
					taskId: "T2-1",
					allowedGlobs: ["docs/code-audit-report.md"],
					blockedCondition: "blocked if findings are unavailable",
				},
			]),
		});
		// Markdown-only audit/report task must not be gated on a whole-project compile.
		expect(contracts[0]!.postStaticCompile).toBeUndefined();
	});

	it("enables postStaticCompile for a write task with a wildcard source glob", () => {
		const { contracts } = refineDag(mkDag(), {
			inputs: { ...baseInputs, staticCompileCommands: ["npm run typecheck"] },
			refinement: refinement([
				{
					taskId: "T2-1",
					allowedGlobs: ["src/**"],
					blockedCondition: "blocked if context is missing",
				},
			]),
		});
		expect(contracts[0]!.postStaticCompile).toEqual({
			required: true,
			commands: ["npm run typecheck"],
		});
	});

	it("enables postStaticCompile for test_runner contracts", () => {
		const dag = mkDag({
			phases: [
				{
					id: "P2",
					name: "validation",
					tasks: [
						{
							id: "T2-2",
							personaId: "test_runner",
							objective: "run upload validation",
							parallelGroup: "validation",
							dependsOn: ["T2-1"],
							needsRefine: false,
						},
					],
				},
			],
		});
		const { contracts, errors } = refineDag(dag, {
			inputs: { ...baseInputs, staticCompileCommands: ["npm run typecheck"] },
			refinement: refinement([]),
		});
		expect(errors).toEqual([]);
		expect(contracts[0]!.postStaticCompile).toEqual({
			required: true,
			commands: ["npm run typecheck"],
		});
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

	it("uses coarse repair DAG acceptance when refinement omits acceptance", () => {
		const dag = mkDag({
			phases: [
				{
					id: "P3.5-repair-1",
					name: "mission-check repair",
					tasks: [
						{
							id: "T3.5-1-1",
							personaId: "code_executor",
							objective: "patch missing edge case",
							parallelGroup: "mission-repair-1",
							dependsOn: [],
							needsRefine: true,
							acceptance: ["Rejected files produce a clear error."],
							priority: "P1",
							sourceIssue: "W3.5 found a missing path.",
							blocking: true,
						},
					],
				},
			],
		});
		const { contracts } = refineDag(dag, {
			inputs: baseInputs,
			refinement: refinement([
				{
					taskId: "T3.5-1-1",
					allowedGlobs: ["src/upload.ts"],
					blockedCondition: "blocked if W3.5 repair source issue is still ambiguous",
				},
			]),
		});

		expect(contracts[0]!.acceptance).toEqual(["Rejected files produce a clear error."]);
	});

	it("uses repair DAG allowedGlobs when a T3.5 task has no refinement entry", () => {
		const dag = mkDag({
			phases: [
				{
					id: "P3.5-repair-1",
					name: "mission-check repair",
					tasks: [
						{
							id: "T3.5-1-1",
							personaId: "code_executor",
							objective: "patch missing edge case",
							parallelGroup: "mission-repair-1",
							dependsOn: [],
							needsRefine: true,
							allowedGlobs: ["src/upload.ts"],
							acceptance: ["Rejected files produce a clear error."],
						},
					],
				},
			],
		});
		const { contracts, errors } = refineDag(dag, {
			inputs: baseInputs,
			refinement: refinement([]),
		});

		expect(contracts[0]!.pathPolicy.allowedGlobs).toEqual(["src/upload.ts"]);
		expect(errors.some((e) => e.taskId === "T3.5-1-1" && e.errors.some((m) => m.includes("allowedGlobs")))).toBe(false);
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
		const refinementMap = new Map<string, RefinementEntry>([
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
		const { contracts, errors } = refineDag(dag, { inputs: baseInputs, refinement: refinementMap });
		expect(errors).toEqual([]);
		const byId = new Map(contracts.map((c) => [c.taskId, c]));
		expect(byId.get("T1-scaffold")!.interfaceContracts).toHaveLength(1);
		expect(byId.get("T2-be")!.interfaceContracts![0]!.id).toBe("IC-todo");
		expect(byId.get("T3-fe")!.interfaceContracts![0]!.id).toBe("IC-todo");
	});

	it("leaves interfaceContracts undefined for tasks with no shared surface", () => {
		const { contracts, errors } = refineDag(mkDag(), {
			inputs: baseInputs,
			refinement: refinement([
				{
					taskId: "T2-1",
					allowedGlobs: ["src/upload.ts"],
					acceptance: ["ok"],
					nonGoals: ["no"],
					blockedCondition: "blocked if T0-1.file_list is unavailable",
				},
			]),
		});
		expect(errors).toEqual([]);
		expect(contracts[0]!.interfaceContracts).toBeUndefined();
	});
});

describe("master capability grants", () => {
	it("grant fields default to empty on a contract with no granted entry", () => {
		const { contracts } = refineDag(mkDag(), {
			inputs: baseInputs,
			refinement: new Map(),
			validate: false,
		});
		const c = contracts.find((x) => x.taskId === "T2-1")!;
		expect(c.grantedSkills).toEqual([]);
		expect(c.grantedMcpTools).toEqual([]);
	});

	it("compileRefinement parses grantedSkills and grantedMcpTools, defaulting to []", () => {
		const text = `<refine>{"tasks":[
			{"taskId":"T2-1","allowedGlobs":["src/a.ts"],"grantedSkills":["pdf-extract"],"grantedMcpTools":["mcp__gh__create_issue"]},
			{"taskId":"T2-2","allowedGlobs":["src/b.ts"]}
		]}</refine>`;
		const res = compileRefinement(text);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.entries.get("T2-1")!.grantedSkills).toEqual(["pdf-extract"]);
		expect(res.entries.get("T2-1")!.grantedMcpTools).toEqual(["mcp__gh__create_issue"]);
		expect(res.entries.get("T2-2")!.grantedSkills).toEqual([]);
		expect(res.entries.get("T2-2")!.grantedMcpTools).toEqual([]);
	});

	it("flows a parsed grant onto the assembled contract", () => {
		const res = compileRefinement(
			`<refine>{"tasks":[{"taskId":"T2-1","allowedGlobs":["src/upload.ts"],"acceptance":["x"],"blockedCondition":"blocked if T0-1.file_list is unavailable or incomplete","grantedMcpTools":["mcp__gh__create_issue"]}]}</refine>`,
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const { contracts } = refineDag(mkDag(), {
			inputs: baseInputs,
			refinement: res.entries,
			validate: false,
		});
		expect(contracts.find((c) => c.taskId === "T2-1")!.grantedMcpTools).toEqual(["mcp__gh__create_issue"]);
	});

	it("rejects a non-string-array grant", () => {
		const res = compileRefinement(
			`<refine>{"tasks":[{"taskId":"T2-1","allowedGlobs":["src/a.ts"],"grantedSkills":"pdf"}]}</refine>`,
		);
		expect(res.ok).toBe(false);
	});
});

describe("interfaceContracts in compileRefinement", () => {
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
});
