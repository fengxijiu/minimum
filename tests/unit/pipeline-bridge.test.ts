import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectText,
	createPlannerBridge,
	createWorkerExecutor,
	type CompletionClient,
} from "../../src/orchestration/index.js";
import { PipelineBridge, summarizePipelineBrief, summarizePipelineComplete, translatePipelineEvent } from "../../src/bridge/index.js";
import type { UiEvent } from "../../src/bridge/index.js";
import type { ChoicePayload, ChoiceVerdict, ConfirmationGate } from "../../src/tools/choice/ConfirmationGate.js";

/** A client that returns a scripted response per call, in order. */
function scriptedClient(responses: string[]): CompletionClient {
	let i = 0;
	return {
		async *streamChat() {
			const text = responses[Math.min(i, responses.length - 1)] ?? "";
			i++;
			yield { type: "content", content: text };
		},
	};
}

const DAG = `<task_dag>{"epic":"e","phases":[
	{"id":"P0","name":"perception","tasks":[{"id":"T0-1","persona":"repo_scout","objective":"scan repo layout","parallelGroup":"perception","dependsOn":[],"needsRefine":false}]},
	{"id":"P2","name":"impl","tasks":[{"id":"T2-1","persona":"code_executor","objective":"implement the endpoint","parallelGroup":"backend","dependsOn":["T0-1"],"needsRefine":true}]}
]}</task_dag>`;
const REFINE = `<refine>{"tasks":[{"taskId":"T2-1","allowedGlobs":["src/x.ts"],"acceptance":["ok"]}]}</refine>`;
const WORKER = `<task_report><status>ok</status>done</task_report>`;
const MISSION = `# W3.5 Loop Detection Report

## 1. Final Decision

Decision: APPROVED_TO_W4

Reason:

- Ready.
`;
const FINALIZE = `<finalize>{"memory_decisions":[]}</finalize>`;
const FINAL_BRIEF = `<final_brief># Result\n\nThe final output is a concise task brief.</final_brief>`;

class ScriptedChoiceGate implements ConfirmationGate {
	payloads: ChoicePayload[] = [];
	constructor(private verdicts: ChoiceVerdict[] = [{ type: "pick", optionId: "continue_w23" }]) {}
	async ask(payload: ChoicePayload): Promise<ChoiceVerdict> {
		this.payloads.push(payload);
		return this.verdicts.shift() ?? { type: "pick", optionId: "continue_w23" };
	}
}

describe("collectText", () => {
	it("concatenates content chunks", async () => {
		const client: CompletionClient = {
			async *streamChat() {
				yield { type: "content", content: "hello " };
				yield { type: "reasoning", content: "(ignored)" };
				yield { type: "content", content: "world" };
			},
		};
		expect(await collectText(client, [])).toBe("hello world");
	});

	it("throws on an error chunk", async () => {
		const client: CompletionClient = {
			async *streamChat() {
				yield { type: "error", content: "boom" };
			},
		};
		await expect(collectText(client, [])).rejects.toThrow("boom");
	});
});

describe("createPlannerBridge", () => {
	it("returns the master compile output", async () => {
		const planner = createPlannerBridge(scriptedClient([DAG]));
		const out = await planner.compile("build upload", "MEM");
		expect(out).toContain("<task_dag>");
	});

	it("passes canonical memory and context-builder guidance to refine", async () => {
		const calls: any[] = [];
		const client: CompletionClient = {
			async *streamChat(options) {
				calls.push(options);
				yield { type: "content", content: REFINE };
			},
		};
		const planner = createPlannerBridge(client);
		await planner.refine({
			epicId: "e",
			phases: [
				{
					id: "P2",
					name: "impl",
					tasks: [
						{
							id: "T2-1",
							personaId: "code_executor",
							objective: "implement the endpoint",
							parallelGroup: "backend",
							dependsOn: [],
							needsRefine: true,
						},
					],
				},
			],
		}, [], "CANONICAL MEMORY");
		const userMessage = calls[0]!.messages.find((m: any) => m.role === "user")!.content;
		expect(userMessage).toContain("CANONICAL MEMORY");
		expect(userMessage).toContain("Context Builder Persona");
		expect(userMessage).toContain("contextPack");
		expect(userMessage).toContain("requiredRefinementTaskIds");
		expect(userMessage).toContain('"T2-1"');
		expect(userMessage).toContain("must exactly cover requiredRefinementTaskIds");
	});

	it("runs mission checker as an inline persona", async () => {
		const calls: any[] = [];
		const client: CompletionClient = {
			async *streamChat(options) {
				calls.push(options);
				yield { type: "content", content: MISSION };
			},
		};
		const planner = createPlannerBridge(client);
		await planner.checkMission({
			userRequest: "build upload",
			dag: { epicId: "e", phases: [] },
			refinements: [],
			results: [],
			canonicalMemory: "CANONICAL MEMORY",
			knownIssues: ["missing tests"],
			loopIndex: 0,
			maxRepairLoops: 1,
			artifactPaths: {
				dag: ".minimum/tasks/e/dag.json",
				refinements: [".minimum/tasks/e/refinements/initial.json"],
				contracts: [".minimum/tasks/e/contracts/initial.json"],
				confirmations: [],
				missionChecks: [],
				repairDags: [],
				memoryIndex: ".minimum/index.json",
			},
		});
		const systemMessage = calls[0]!.messages.find((m: any) => m.role === "system")!.content;
		const userMessage = calls[0]!.messages.find((m: any) => m.role === "user")!.content;
		expect(systemMessage).toContain("W3.5 Loop Checker");
		expect(userMessage).toContain("build upload");
		expect(userMessage).toContain("CANONICAL MEMORY");
		expect(userMessage).toContain("missing tests");
		expect(userMessage).toContain(".minimum/tasks/e/dag.json");
		expect(userMessage).toContain(".minimum/index.json");
		expect(userMessage).toContain("Decision: APPROVED_TO_W4");
	});

	it("uses master planner deliver input for the final brief", async () => {
		const calls: any[] = [];
		const client: CompletionClient = {
			async *streamChat(options) {
				calls.push(options);
				yield { type: "content", content: FINAL_BRIEF };
			},
		};
		const planner = createPlannerBridge(client);
		await planner.deliver({
			userRequest: "build upload",
			statusReason: "complete",
			results: [{ taskId: "T2-1", personaId: "code_executor", status: "ok", report: "implemented upload", memoryCandidateBody: undefined, errors: [], durationMs: 1 }],
			leafTaskIds: ["T2-1"],
			knownIssues: ["missing screenshots"],
			writtenFilesByTask: [{ taskId: "T2-1", files: ["src/upload.ts"] }],
			finalizeReport: { applied: [], errors: [], stagingCleared: true },
		});
		const systemMessage = calls[0]!.messages.find((m: any) => m.role === "system")!.content;
		const userMessage = calls[0]!.messages.find((m: any) => m.role === "user")!.content;
		expect(systemMessage).not.toContain("You summarize the outcome of a completed multi-agent run");
		expect(userMessage).toContain("# W4 Final Delivery Input");
		expect(userMessage).toContain("## Original User Request");
		expect(userMessage).toContain("## Status Reason");
		expect(userMessage).toContain("## Leaf Deliverable Task IDs");
		expect(userMessage).toContain("## Actual Written Business Files");
		expect(userMessage).toContain("src/upload.ts");
		expect(userMessage).toContain("## Known Issues");
		expect(userMessage).toContain("missing screenshots");
		expect(userMessage).toContain("## Finalize Governance Report");
		expect(userMessage).toContain("<final_brief>");
	});
});

describe("createWorkerExecutor", () => {
	it("runs a persona turn and returns its text", async () => {
		const exec = createWorkerExecutor(scriptedClient([WORKER]));
		const out = await exec.run(
			{
				taskId: "T1",
				phase: "P",
				epicId: "e",
				personaId: "code_executor",
				objective: "do the thing",
				inputs: { userGoal: "g", artifacts: [], constraints: [] },
				pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] },
				acceptance: ["done"],
				outputSchema: "task_report",
				parallelGroup: "g",
				dependsOn: [],
				abortOnConflict: false,
			},
			[],
		);
		expect(out.text).toContain("<task_report>");
	});
});

describe("translatePipelineEvent", () => {
	it("maps phase_start to a pipeline UiEvent", () => {
		const out = translatePipelineEvent({ type: "phase_start", phase: "W0", label: "compile" });
		expect(out[0]).toEqual({ kind: "pipeline", phase: "W0", label: "compile" });
	});

	it("maps pipeline_error to an error UiEvent", () => {
		const out = translatePipelineEvent({ type: "pipeline_error", phase: "W4", error: "bad" });
		expect(out[0]).toEqual({ kind: "error", text: "[W4] bad" });
	});

	it("uses short stage names in choice and human-confirmation notices", () => {
		const choice = translatePipelineEvent({ type: "pipeline_choice", phase: "W2/3", choiceId: "continue_w23", reason: "dag confirmation" });
		expect((choice[0] as any).kind).toBe("notice");
		expect((choice[0] as any).text).toContain("Build");
		expect((choice[0] as any).text).not.toContain("W2/3");

		const human = translatePipelineEvent({ type: "human_confirmation_required", phase: "W3.5", reason: "needs review" });
		expect((human[0] as any).text).toContain("[Accept]");
		expect((human[0] as any).text).not.toContain("W3.5");
	});

	it("maps W0.5 confirmation and W3.5 parse failure to notices", () => {
		const confirmation = translatePipelineEvent({
			type: "dag_confirmation_requested",
			phase: "W0.5",
			passId: "initial",
			brief: "W0.5 DAG 确认",
			flow: "[ready] T2-1",
			artifactPath: ".minimum/tasks/e/confirmations/initial.md",
		});
		const parseFailure = translatePipelineEvent({
			type: "mission_parse_failed",
			phase: "W3.5",
			error: "missing Decision",
			rawExcerpt: "bad report",
			loopIndex: 0,
			attempt: 1,
		});
		expect(confirmation[0]).toMatchObject({ kind: "notice", tone: "warn" });
		expect(parseFailure[0]).toMatchObject({ kind: "notice", tone: "warn" });
		expect(confirmation[0]!.kind).not.toBe("error");
		expect(parseFailure[0]!.kind).not.toBe("error");
	});

	it("maps a task_done wave event to a tool_result", () => {
		const out = translatePipelineEvent({
			type: "wave",
			event: {
				type: "task_done",
				waveIndex: 0,
				result: { taskId: "T1", personaId: "code_executor", status: "ok", report: "", memoryCandidateBody: undefined, errors: [], durationMs: 1 },
			},
		});
		expect(out[0]!.kind).toBe("tool_result");
	});

	it("maps blocked task_done to a warning notice instead of a failed tool_result", () => {
		const out = translatePipelineEvent({
			type: "wave",
			event: {
				type: "task_done",
				waveIndex: 0,
				result: { taskId: "T1", personaId: "code_executor", status: "blocked", report: "missing T0-1.file_list", memoryCandidateBody: undefined, errors: [], durationMs: 1 },
			},
		});
		expect(out[0]).toMatchObject({ kind: "notice", tone: "warn" });
		expect((out[0] as any).text).toContain("T1");
		expect((out[0] as any).text).toContain("blocked");
	});

	it("maps errored task_done to detailed error content", () => {
		const out = translatePipelineEvent({
			type: "wave",
			event: {
				type: "task_done",
				waveIndex: 0,
				result: {
					taskId: "T1",
					personaId: "code_executor",
					status: "contract_invalid",
					report: "",
					memoryCandidateBody: undefined,
					errors: ["blockedCondition must be at least 8 characters"],
					durationMs: 1,
				},
			},
		});
		expect(out[0]).toMatchObject({ kind: "error" });
		expect((out[0] as any).text).toContain("T1");
		expect((out[0] as any).text).toContain("contract_invalid");
		expect((out[0] as any).text).toContain("blockedCondition must be at least 8 characters");
	});

	it("renders the finalBrief for pipeline_complete by default", () => {
		const mk = (taskId: string, personaId: string, report: string) => ({
			taskId,
			personaId,
			status: "ok" as const,
			report,
			memoryCandidateBody: undefined,
			errors: [] as string[],
			durationMs: 1200,
		});
		const out = translatePipelineEvent({
			type: "pipeline_complete",
			results: [
				mk("T2-1", "code_executor", "implemented POST /upload with a 5MB guard"),
				mk("T2-2", "test_runner", "ran vitest upload suite, 12 passed"),
			],
			finalBrief: "# Result\n\nThe final output is a concise task brief.",
			changedFiles: ["src/upload.ts"],
		});
		expect(out[0]).toMatchObject({ kind: "notice", tone: "ok" });
		const text = (out[0] as any).text as string;
		expect(text).toContain("# Result");
		expect(text).toContain("concise task brief");
		expect(text).not.toContain("outputs:");
		expect(text).not.toContain("artifacts:");
	});

	it("shows an explicit placeholder when finalBrief is missing", () => {
		const out = translatePipelineEvent({
			type: "pipeline_complete",
			results: [
				{ taskId: "T2-1", personaId: "code_executor", status: "ok", report: "added 413 path", memoryCandidateBody: "candidate body", errors: [], durationMs: 800 },
			],
		});
		expect(out[0]).toMatchObject({ kind: "notice", tone: "ok" });
		const text = (out[0] as any).text as string;
		expect(text).toContain("Task completed, but no final brief was produced.");
		expect(text).not.toContain("outputs:");
		expect(text).not.toContain("artifacts:");
	});
});

describe("summarizePipelineBrief", () => {
	const okResult = (taskId: string, personaId: string, report: string) => ({
		taskId,
		personaId,
		status: "ok" as const,
		report,
		memoryCandidateBody: undefined,
		errors: [] as string[],
		durationMs: 500,
	});

	it("returns the finalBrief directly when present", () => {
		const summary = summarizePipelineBrief([okResult("T2-1", "code_executor", "implemented upload")], {
			finalBrief: "# Result\n\nShipped `src/upload.ts`.",
			changedFiles: ["src/upload.ts"],
		});
		expect(summary.tone).toBe("ok");
		expect(summary.text).toContain("# Result");
		expect(summary.text).toContain("Shipped `src/upload.ts`.");
		expect(summary.text).not.toContain(".minimum/");
	});

	it("uses an explicit placeholder when finalBrief is missing", () => {
		const summary = summarizePipelineBrief([okResult("T2-1", "code_executor", "implemented upload")]);
		expect(summary.tone).toBe("ok");
		expect(summary.text).toBe("Task completed, but no final brief was produced.");
	});

	it("keeps warn tone when blocked or error results exist", () => {
		const summary = summarizePipelineBrief([
			{
				taskId: "T2-2",
				personaId: "test_runner",
				status: "blocked" as const,
				report: "missing screenshots",
				memoryCandidateBody: undefined,
				errors: [],
				durationMs: 100,
			},
		]);
		expect(summary.tone).toBe("warn");
		expect(summary.text).toBe("Task completed, but no final brief was produced.");
	});
});

describe("summarizePipelineComplete writes", () => {
	const okResult = (taskId: string, personaId: string, report: string) => ({
		taskId,
		personaId,
		status: "ok" as const,
		report,
		memoryCandidateBody: undefined,
		errors: [] as string[],
		durationMs: 500,
	});

	it("lists each task's written files when a map is supplied", () => {
		const written = new Map<string, Set<string>>([
			["T2-1", new Set(["src/api/upload.ts", "src/api/limits.ts"])],
			["T2-2", new Set()],
		]);
		const { text } = summarizePipelineComplete(
			[okResult("T2-1", "code_executor", "implemented upload"), okResult("T2-2", "test_runner", "ran tests")],
			written,
		);
		expect(text).toContain("- T2-1 (code_executor) ok");
		expect(text).toContain("writes (2): src/api/upload.ts, src/api/limits.ts");
		// A task with no writes (e.g. test_runner) shows no writes line.
		expect(text).not.toContain("- T2-2 (test_runner) ok · 0.5s\n      ran tests\n      writes");
	});

	it("omits the writes line entirely when no map is supplied", () => {
		const { text } = summarizePipelineComplete([okResult("T2-1", "code_executor", "implemented upload")]);
		expect(text).not.toContain("writes (");
	});

	it("surfaces goal, conclusion, terminal deliverable, and artifacts when meta is supplied", () => {
		const { text } = summarizePipelineComplete(
			[okResult("T0-1", "repo_scout", "found the routes"), okResult("T2-1", "reviewer", "recommend p95 latency + error-rate metrics")],
			undefined,
			{
				goal: "explore what metrics to add",
				conclusion: "Found 8 monitorable surfaces.\n- p95 latency\n- error rate",
				leafTaskIds: ["T2-1"],
				artifacts: ["/repo/.minimum/tasks/x/dag.json"],
			},
		);
		expect(text).toContain("goal: explore what metrics to add");
		expect(text).toContain("conclusion:");
		expect(text).toContain("Found 8 monitorable surfaces.");
		expect(text).toContain("- p95 latency");
		// Terminal task promoted into its own result section…
		expect(text).toContain("result:");
		expect(text).toContain("- T2-1 (reviewer)");
		expect(text).toContain("recommend p95 latency + error-rate metrics");
		// …and skipped in the outputs ledger so the deliverable is not printed twice.
		expect(text).not.toContain("- T2-1 (reviewer) ok");
		// …while the non-leaf task still appears in the outputs ledger.
		expect(text).toContain("- T0-1 (repo_scout) ok");
		expect(text.indexOf("result:")).toBeLessThan(text.indexOf("outputs:"));
		expect(text).toContain("artifacts:");
		expect(text).toContain("- /repo/.minimum/tasks/x/dag.json");
	});

	it("renders the legacy summary unchanged when no meta is supplied", () => {
		const { text } = summarizePipelineComplete([okResult("T2-1", "reviewer", "done")]);
		expect(text).not.toContain("goal:");
		expect(text).not.toContain("conclusion:");
		expect(text).not.toContain("result:");
		expect(text).not.toContain("artifacts:");
		expect(text).toContain("outputs:");
	});
});

describe("PipelineBridge", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-bridge-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("streams pipeline UiEvents and ends with done:true", async () => {
		// compile, (perception worker), refine, (impl worker), mission check, finalize
		const client = scriptedClient([DAG, WORKER, REFINE, WORKER, MISSION, FINALIZE]);
		const bridge = new PipelineBridge(client, { projectRoot: dir, choiceGate: new ScriptedChoiceGate() });
		const events: UiEvent[] = [];
		for await (const e of bridge.send("build an upload endpoint")) events.push(e);

		const phases = events.filter((e) => e.kind === "pipeline").map((e) => (e as any).phase);
		expect(phases).toContain("W0");
		expect(phases).toContain("W3.5");
		expect(phases).toContain("W4");
		const last = events[events.length - 1]!;
		expect(last).toEqual({ kind: "done", success: true });
	});

	it("emits an error UiEvent when compile yields no DAG", async () => {
		const client = scriptedClient(["no dag here"]);
		const bridge = new PipelineBridge(client, { projectRoot: dir });
		const events: UiEvent[] = [];
		for await (const e of bridge.send("x")) events.push(e);
		expect(events.some((e) => e.kind === "error")).toBe(true);
		expect(events[events.length - 1]).toEqual({ kind: "done", success: false });
	});

	it("stores and reloads top-level orchestrate history", async () => {
		const client = scriptedClient([DAG, WORKER, REFINE, WORKER, MISSION, FINALIZE]);
		const bridge = new PipelineBridge(client, { projectRoot: dir, choiceGate: new ScriptedChoiceGate() });
		for await (const _ of bridge.send("build an upload endpoint")) {
			/* drain */
		}
		const history = bridge.getHistory();
		expect(history.at(-2)).toMatchObject({ role: "user", content: "build an upload endpoint" });
		expect(history.at(-1)).toMatchObject({ role: "assistant" });

		const resumed = new PipelineBridge(scriptedClient([DAG, WORKER, REFINE, WORKER, MISSION, FINALIZE]), {
			projectRoot: dir,
			choiceGate: new ScriptedChoiceGate(),
		});
		resumed.loadHistory(history);
		expect(resumed.getHistory()).toEqual(history);
	});
});

import { buildCatalogForBridge } from "../../src/bridge/index.js";

describe("buildCatalogForBridge", () => {
	let bdir: string;
	beforeEach(() => {
		bdir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cat-"));
		const learned = path.join(bdir, ".minimum", "skills", "learned", "pdf-extract");
		fs.mkdirSync(learned, { recursive: true });
		fs.writeFileSync(path.join(learned, "SKILL.md"), "---\n---\n## When to Use\n- PDF\n");
	});
	afterEach(() => fs.rmSync(bdir, { recursive: true, force: true }));

	const host = {
		getDefinitions: () => [
			{ name: "read_file", description: "", parameters: { type: "object", properties: {} } },
			{ name: "mcp__gh__create_issue", description: "open issue", parameters: { type: "object", properties: {} } },
			{ name: "mcp__gh__delete_repo", description: "danger", parameters: { type: "object", properties: {} } },
		],
	};

	it("builds a catalog from host MCP tools minus denylist (skipping non-mcp tools)", async () => {
		const cat = await buildCatalogForBridge({
			projectRoot: bdir,
			tools: host as never,
			capabilityGrants: { enabled: true, denylistSkills: [], denylistMcpTools: ["mcp__gh__delete_repo"] },
		});
		expect(cat!.mcpTools.map((t) => t.name)).toEqual(["mcp__gh__create_issue"]);
		expect(cat!.skills.map((s) => s.id)).toContain("pdf-extract");
	});

	it("returns undefined when grants are disabled", async () => {
		const cat = await buildCatalogForBridge({ projectRoot: bdir, tools: undefined, capabilityGrants: { enabled: false } });
		expect(cat).toBeUndefined();
	});
});
