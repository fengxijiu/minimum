import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkerLoop } from "../../src/orchestration/WorkerLoop.js";
import type {
	IApprovalManager,
	IStreamingClient,
	IToolHost,
} from "../../src/loop/MiMoLoop.js";
import type { Persona } from "../../src/personas/Persona.js";
import type { TaskContract } from "../../src/orchestration/TaskContract.js";
import type {
	ICodeValidator,
	ValidationResult,
} from "../../src/types/validator.js";

// ── helpers ─────────────────────────────────────────────────────────────

interface ScriptedTurn {
	content?: string;
	toolCalls?: Array<{ id: string; name: string; args: string }>;
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		cachedTokens?: number;
	};
}

function scriptedClient(turns: ScriptedTurn[]): IStreamingClient {
	let i = 0;
	return {
		async *streamChat() {
			const turn = turns[i++];
			if (!turn) {
				yield { type: "content" as const, content: "" };
				yield { type: "done" as const };
				return;
			}
			if (turn.content) {
				yield { type: "content" as const, content: turn.content };
			}
			for (const tc of turn.toolCalls ?? []) {
				yield {
					type: "tool_call" as const,
					toolCall: {
						id: tc.id,
						type: "function",
						function: { name: tc.name, arguments: tc.args },
					},
				};
			}
			if (turn.usage) {
				yield {
					type: "usage" as const,
					usage: {
						promptTokens: turn.usage.promptTokens,
						completionTokens: turn.usage.completionTokens,
						totalTokens: turn.usage.totalTokens,
						cachedTokens: turn.usage.cachedTokens ?? 0,
					},
				};
			}
			yield { type: "done" as const };
		},
	};
}

interface ToolCallRecord {
	name: string;
	args: string;
}

function recordingToolHost(
	available: string[],
	result: (name: string) => { content: string; isError?: boolean },
): IToolHost & { calls: ToolCallRecord[] } {
	const calls: ToolCallRecord[] = [];
	return {
		calls,
		getDefinitions() {
			return available.map((name) => ({
				name,
				description: name,
				parameters: { type: "object" as const, properties: {} },
			}));
		},
		async execute(toolCall) {
			calls.push({
				name: toolCall.function.name,
				args: toolCall.function.arguments,
			});
			return result(toolCall.function.name);
		},
	};
}

function persona(overrides: Partial<Persona> = {}): Persona {
	return {
		id: "code_executor",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: "you are a worker",
		toolAllowlist: ["read_file", "write_file"],
		toolDenylist: ["exec_shell"],
		pathPolicy: {
			canWrite: true,
			alwaysAllowedGlobs: [],
			forbiddenGlobs: [],
		},
		maxSteps: 5,
		maxTokens: 32_000,
		outputSchema: "task_report",
		parallelism: { soloPerWave: false, maxConcurrent: 2 },
		...overrides,
	} as Persona;
}

function contract(overrides: Partial<TaskContract> = {}): TaskContract {
	return {
		taskId: "T1",
		phase: "P1",
		epicId: "e",
		personaId: "code_executor",
		objective: "do",
		inputs: { userGoal: "", artifacts: [], constraints: [] },
		pathPolicy: { allowedGlobs: ["src/**"], forbiddenGlobs: [] },
		acceptance: [],
		outputSchema: "task_report",
		parallelGroup: "g",
		dependsOn: [],
		abortOnConflict: false,
		...overrides,
	} as TaskContract;
}

// ── tests ───────────────────────────────────────────────────────────────

describe("WorkerLoop", () => {
	it("executes tool calls and feeds results back to the model", async () => {
		const client = scriptedClient([
			{
				toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"src/a.ts"}' }],
				usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
			},
			{
				content: "<task_report>done</task_report>",
				usage: { promptTokens: 200, completionTokens: 60, totalTokens: 260 },
			},
		]);
		const tools = recordingToolHost(
			["read_file", "write_file"],
			() => ({ content: "file contents" }),
		);
		const loop = new WorkerLoop({
			client,
			tools,
			projectRoot: "/repo",
			model: "mimo-v2.5",
		});

		const result = await loop.runTask({
			systemPrompt: "sys",
			userPrompt: "go",
			persona: persona(),
			contract: contract(),
		});

		expect(result.text).toContain("<task_report>");
		expect(result.hitStepLimit).toBe(false);
		expect(tools.calls).toHaveLength(1);
		expect(tools.calls[0]?.name).toBe("read_file");
		expect(result.usage.toolCalls).toBe(1);
		expect(result.usage.promptTokens).toBe(300);
		expect(result.usage.completionTokens).toBe(110);
	});

	it("denies tools not in the persona allowlist before executing", async () => {
		const client = scriptedClient([
			{
				toolCalls: [{ id: "c1", name: "exec_shell", args: '{"command":"rm -rf /"}' }],
				usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
			},
			{
				content: "<task_report>blocked</task_report>",
				usage: { promptTokens: 60, completionTokens: 20, totalTokens: 80 },
			},
		]);
		const tools = recordingToolHost(["read_file"], () => ({ content: "ok" }));
		const events: string[] = [];
		const loop = new WorkerLoop({ client, tools, projectRoot: "/repo" });

		await loop.runTask({
			systemPrompt: "sys",
			userPrompt: "go",
			persona: persona(),
			contract: contract(),
			onEvent: (ev) => {
				if (ev.type === "tool_denied") events.push(ev.reason);
			},
		});

		// exec_shell is in the persona denylist -> denied before reaching the tool host
		expect(tools.calls).toHaveLength(0);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatch(/denylist|allowlist/);
	});

	it("allows write personas to run only whitelisted postStaticCompile shell commands", async () => {
		const client = scriptedClient([
			{
				toolCalls: [{ id: "c1", name: "exec_shell", args: '{"command":"npm run typecheck"}' }],
				usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
			},
			{
				content: "<task_report><status>ok</status>done</task_report>",
				usage: { promptTokens: 60, completionTokens: 20, totalTokens: 80 },
			},
		]);
		const tools = recordingToolHost(["exec_shell"], () => ({ content: "typecheck ok" }));
		const loop = new WorkerLoop({ client, tools, projectRoot: "/repo" });

		const result = await loop.runTask({
			systemPrompt: "sys",
			userPrompt: "go",
			persona: persona(),
			contract: contract({
				inputs: { userGoal: "", artifacts: [], constraints: [], staticCompileCommands: ["npm run typecheck"] },
				postStaticCompile: { required: true, commands: ["npm run typecheck"] },
			}),
		});

		expect(result.text).toContain("<task_report>");
		expect(tools.calls).toHaveLength(1);
		expect(tools.calls[0]?.name).toBe("exec_shell");
	});

	it("denies non-whitelisted postStaticCompile shell commands for write personas", async () => {
		const client = scriptedClient([
			{
				toolCalls: [{ id: "c1", name: "exec_shell", args: '{"command":"npm test"}' }],
				usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
			},
			{
				content: "<task_report><status>blocked</status>done</task_report>",
				usage: { promptTokens: 60, completionTokens: 20, totalTokens: 80 },
			},
		]);
		const tools = recordingToolHost(["exec_shell"], () => ({ content: "ok" }));
		const denies: string[] = [];
		const loop = new WorkerLoop({ client, tools, projectRoot: "/repo" });

		await loop.runTask({
			systemPrompt: "sys",
			userPrompt: "go",
			persona: persona(),
			contract: contract({
				inputs: { userGoal: "", artifacts: [], constraints: [], staticCompileCommands: ["npm run typecheck"] },
				postStaticCompile: { required: true, commands: ["npm run typecheck"] },
			}),
			onEvent: (ev) => {
				if (ev.type === "tool_denied") denies.push(ev.reason);
			},
		});

		expect(tools.calls).toHaveLength(0);
		expect(denies[0]).toMatch(/static compile/i);
	});

	it("blocks writes that escape contract.allowedGlobs", async () => {
		const client = scriptedClient([
			{
				toolCalls: [{ id: "c1", name: "write_file", args: '{"path":"tests/spec.ts","content":"x"}' }],
				usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
			},
			{
				content: "<task_report>blocked</task_report>",
				usage: { promptTokens: 60, completionTokens: 20, totalTokens: 80 },
			},
		]);
		const tools = recordingToolHost(["write_file"], () => ({ content: "wrote" }));
		const denies: string[] = [];
		const loop = new WorkerLoop({ client, tools, projectRoot: "/repo" });

		await loop.runTask({
			systemPrompt: "sys",
			userPrompt: "go",
			persona: persona(),
			contract: contract({
				pathPolicy: { allowedGlobs: ["src/**"], forbiddenGlobs: [] },
			}),
			onEvent: (ev) => {
				if (ev.type === "tool_denied") denies.push(ev.reason);
			},
		});

		expect(tools.calls).toHaveLength(0);
		expect(denies[0]).toMatch(/allowed glob/i);
	});

	it("respects ApprovalManager veto", async () => {
		const client = scriptedClient([
			{
				toolCalls: [{ id: "c1", name: "write_file", args: '{"path":"src/x.ts","content":"x"}' }],
				usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
			},
			{
				content: "<task_report>blocked</task_report>",
				usage: { promptTokens: 60, completionTokens: 20, totalTokens: 80 },
			},
		]);
		const tools = recordingToolHost(["write_file"], () => ({ content: "wrote" }));
		const approval: IApprovalManager = {
			async requestApproval(tool, args, description) {
				return { id: "a1", tool, args, risk: "medium", description, timestamp: Date.now() } as any;
			},
			async checkApproval() {
				return { approved: false, reason: "user denied" } as any;
			},
		};
		const denies: string[] = [];
		const loop = new WorkerLoop({
			client,
			tools,
			projectRoot: "/repo",
			approvalManager: approval,
		});

		await loop.runTask({
			systemPrompt: "sys",
			userPrompt: "go",
			persona: persona(),
			contract: contract(),
			onEvent: (ev) => {
				if (ev.type === "tool_denied") denies.push(ev.reason);
			},
		});

		expect(tools.calls).toHaveLength(0);
		expect(denies[0]).toContain("user denied");
	});

	it("stops at maxSteps and reports hitStepLimit", async () => {
		// Infinitely looping client — always returns a tool call
		const client: IStreamingClient = {
			async *streamChat() {
				yield {
					type: "tool_call" as const,
					toolCall: {
						id: `c${Math.random()}`,
						type: "function",
						function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
					},
				};
				yield {
					type: "usage" as const,
					usage: {
						promptTokens: 10,
						completionTokens: 10,
						totalTokens: 20,
						cachedTokens: 0,
					},
				};
				yield { type: "done" as const };
			},
		};
		const tools = recordingToolHost(["read_file"], () => ({ content: "x" }));
		const loop = new WorkerLoop({ client, tools, projectRoot: "/repo" });

		const result = await loop.runTask({
			systemPrompt: "sys",
			userPrompt: "go",
			persona: persona(),
			contract: contract(),
			maxSteps: 3,
		});

		expect(result.hitStepLimit).toBe(true);
		expect(result.usage.steps).toBe(3);
		expect(tools.calls).toHaveLength(3);
	});

	it("marks a done-only final turn as an empty stream", async () => {
		const client = scriptedClient([{}]);
		const tools = recordingToolHost(["read_file"], () => ({ content: "x" }));
		const loop = new WorkerLoop({ client, tools, projectRoot: "/repo" });

		const result = await loop.runTask({
			systemPrompt: "sys",
			userPrompt: "go",
			persona: persona(),
			contract: contract(),
		});

		expect(result.hitStepLimit).toBe(false);
		expect(result.emptyFinalTurn).toBe(true);
		expect(result.finishReason).toBe("empty_stream");
	});

	it("marks a usage-only final turn as an empty stream", async () => {
		const client = scriptedClient([
			{
				usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
			},
		]);
		const tools = recordingToolHost(["read_file"], () => ({ content: "x" }));
		const loop = new WorkerLoop({ client, tools, projectRoot: "/repo" });

		const result = await loop.runTask({
			systemPrompt: "sys",
			userPrompt: "go",
			persona: persona(),
			contract: contract(),
		});

		expect(result.hitStepLimit).toBe(false);
		expect(result.emptyFinalTurn).toBe(true);
		expect(result.finishReason).toBe("empty_stream");
		expect(result.usage.totalTokens).toBe(10);
	});

	it("marks a reasoning-only final turn as an empty stream", async () => {
		const client: IStreamingClient = {
			async *streamChat() {
				yield { type: "reasoning" as const, content: "thinking without final content" };
				yield { type: "done" as const };
			},
		};
		const tools = recordingToolHost(["read_file"], () => ({ content: "x" }));
		const loop = new WorkerLoop({ client, tools, projectRoot: "/repo" });

		const result = await loop.runTask({
			systemPrompt: "sys",
			userPrompt: "go",
			persona: persona(),
			contract: contract(),
		});

		expect(result.hitStepLimit).toBe(false);
		expect(result.emptyFinalTurn).toBe(true);
		expect(result.finishReason).toBe("empty_stream");
	});

	// ── snapshot + validator rollback ──────────────────────────────────────

	it("rolls back a write when the validator reports issues", async () => {
		// Real temp directory so SnapshotManager can read/write actual files.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-rollback-"));
		const target = "src/a.ts";
		const targetAbs = path.join(dir, target);
		fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
		const originalContent = "export const original = true;\n";
		fs.writeFileSync(targetAbs, originalContent, "utf-8");

		// Tool host that *actually* overwrites the file so a rollback is observable.
		const tools: IToolHost = {
			getDefinitions() {
				return [
					{
						name: "write_file",
						description: "write",
						parameters: { type: "object" as const, properties: {} },
					},
				];
			},
			async execute(toolCall) {
				const args = JSON.parse(toolCall.function.arguments);
				const abs = path.join(dir, args.path);
				fs.writeFileSync(abs, args.content, "utf-8");
				return { content: `wrote ${args.path}` };
			},
		};

		// Validator that always fails on this file with a single type error.
		const validator: ICodeValidator = {
			async validate(): Promise<ValidationResult> {
				return {
					passed: false,
					severity: "error",
					checks: [
						{
							name: "tsc",
							type: "type",
							passed: false,
							severity: "error",
							message: "Type 'string' is not assignable to type 'number'.",
							location: { file: "src/a.ts", line: 1, column: 14 },
						},
					],
					suggestions: [],
				};
			},
			registerChecker() {},
			setCheckerEnabled() {},
		};

		const client = scriptedClient([
			{
				toolCalls: [
					{
						id: "c1",
						name: "write_file",
						args: JSON.stringify({
							path: target,
							content: "export const broken: number = 'oops';\n",
						}),
					},
				],
				usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
			},
			{
				content: "<task_report>tried to write, validator rejected</task_report>",
				usage: { promptTokens: 60, completionTokens: 20, totalTokens: 80 },
			},
		]);

		const events: Array<{ type: string; restored?: boolean; issues?: number }> = [];
		const loop = new WorkerLoop({
			client,
			tools,
			validator,
			projectRoot: dir,
		});

		const result = await loop.runTask({
			systemPrompt: "sys",
			userPrompt: "go",
			persona: persona(),
			contract: contract({
				pathPolicy: { allowedGlobs: ["src/**"], forbiddenGlobs: [] },
			}),
			onEvent: (ev) => {
				if (ev.type === "tool_rolled_back") {
					events.push({ type: ev.type, restored: ev.restored, issues: ev.issues });
				}
			},
		});

		// File must be back to its pre-edit content.
		expect(fs.readFileSync(targetAbs, "utf-8")).toBe(originalContent);
		// Rollback event observed.
		expect(events).toEqual([
			{ type: "tool_rolled_back", restored: true, issues: 1 },
		]);
		// Worker exits cleanly with a report.
		expect(result.text).toContain("<task_report>");

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("keeps the write when the validator passes", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-pass-"));
		const target = "src/b.ts";
		const targetAbs = path.join(dir, target);
		fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
		fs.writeFileSync(targetAbs, "before\n", "utf-8");

		const tools: IToolHost = {
			getDefinitions() {
				return [
					{
						name: "write_file",
						description: "write",
						parameters: { type: "object" as const, properties: {} },
					},
				];
			},
			async execute(toolCall) {
				const args = JSON.parse(toolCall.function.arguments);
				fs.writeFileSync(path.join(dir, args.path), args.content, "utf-8");
				return { content: "wrote" };
			},
		};

		const validator: ICodeValidator = {
			async validate(): Promise<ValidationResult> {
				return {
					passed: true,
					severity: "info",
					checks: [],
					suggestions: [],
				};
			},
			registerChecker() {},
			setCheckerEnabled() {},
		};

		const client = scriptedClient([
			{
				toolCalls: [
					{
						id: "c1",
						name: "write_file",
						args: JSON.stringify({ path: target, content: "after\n" }),
					},
				],
				usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
			},
			{
				content: "<task_report>ok</task_report>",
				usage: { promptTokens: 60, completionTokens: 20, totalTokens: 80 },
			},
		]);

		const rolledBack: unknown[] = [];
		const loop = new WorkerLoop({
			client,
			tools,
			validator,
			projectRoot: dir,
		});

		await loop.runTask({
			systemPrompt: "sys",
			userPrompt: "go",
			persona: persona(),
			contract: contract({
				pathPolicy: { allowedGlobs: ["src/**"], forbiddenGlobs: [] },
			}),
			onEvent: (ev) => {
				if (ev.type === "tool_rolled_back") rolledBack.push(ev);
			},
		});

		// File preserved with the model's new content; no rollback event.
		expect(fs.readFileSync(targetAbs, "utf-8")).toBe("after\n");
		expect(rolledBack).toHaveLength(0);

		fs.rmSync(dir, { recursive: true, force: true });
	});
});

import { selectPersonaTools } from "../../src/orchestration/WorkerLoop.js";
import { getPersona } from "../../src/personas/PersonaRegistry.js";
import type { ToolDefinition } from "../../src/types/common.js";

function defs(...names: string[]): ToolDefinition[] {
	return names.map((name) => ({ name, description: "", parameters: { type: "object", properties: {} } }));
}

describe("selectPersonaTools (master-granted MCP)", () => {
	const repoScout = getPersona("repo_scout");

	it("exposes a granted MCP tool the persona allowlist lacks", () => {
		const names = selectPersonaTools(
			defs("read_file", "mcp__gh__create_issue"),
			repoScout,
			["mcp__gh__create_issue"],
		).map((t) => t.name);
		expect(names).toContain("read_file");
		expect(names).toContain("mcp__gh__create_issue");
	});

	it("does not expose an ungranted MCP tool", () => {
		const names = selectPersonaTools(
			defs("read_file", "mcp__gh__create_issue"),
			repoScout,
			[],
		).map((t) => t.name);
		expect(names).not.toContain("mcp__gh__create_issue");
	});

	it("never exposes a granted tool that is in the persona denylist", () => {
		const names = selectPersonaTools(defs("read_file", "exec_shell"), repoScout, ["exec_shell"]).map((t) => t.name);
		expect(names).not.toContain("exec_shell");
	});

	it("exposes readonly fallback shell tools without exposing denied shell execution", () => {
		const names = selectPersonaTools(
			defs("read_file", "shell_fs_read", "shell_search", "shell_git_read", "exec_shell"),
			repoScout,
			["shell_fs_read", "shell_search", "shell_git_read", "exec_shell"],
		).map((t) => t.name);
		expect(names).toContain("read_file");
		expect(names).toContain("shell_fs_read");
		expect(names).toContain("shell_search");
		expect(names).toContain("shell_git_read");
		expect(names).not.toContain("exec_shell");
	});
});
