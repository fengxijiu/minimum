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
import { PipelineBridge, translatePipelineEvent } from "../../src/bridge/index.js";
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
