import { describe, expect, it } from "vitest";
import { EngineBridge, mapLoopEvent } from "../../src/bridge/EngineBridge.js";
import { MiMoLoop } from "../../src/loop/MiMoLoop.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";
import { TodoWriteTool } from "../../src/tools/todo/TodoWriteTool.js";

function makeTool(
	name: string,
	fn: (args: any) => Promise<string>,
	description = "test tool",
) {
	return {
		name,
		description,
		getDefinition() {
			return {
				name,
				description,
				parameters: { type: "object", properties: {} },
			};
		},
		execute: fn,
	};
}

// A streaming client that plays back scripted turns. Each turn is an array of
// chunks; one turn is consumed per streamChat() call.
class FakeClient {
	private turns: any[][];
	constructor(turns: any[][]) {
		this.turns = [...turns];
	}
	async *streamChat(): AsyncGenerator<any> {
		const turn = this.turns.shift() ?? [{ type: "content", content: "done" }];
		for (const c of turn) yield c;
		yield { type: "usage", usage: { totalTokens: 10 } };
	}
}

const toolCallChunk = (name: string, args: object) => ({
	type: "tool_call",
	toolCall: { id: "t1", function: { name, arguments: JSON.stringify(args) } },
});

describe("P0-3 plan mode", () => {
	it("blocks a mutating tool and never executes it", async () => {
		const tools = new ToolRegistry();
		let executed = false;
		tools.register(
			makeTool("write_file", async () => {
				executed = true;
				return "ok";
			}),
		);

		const loop = new MiMoLoop({
			client: new FakeClient([
				[toolCallChunk("write_file", { path: "a.ts", content: "x" })],
				[{ type: "content", content: "plan ready" }],
			]),
			tools,
			workingDirectory: "/test",
			planMode: true,
			enableReadGuard: false,
			maxSteps: 5,
		});

		const events: any[] = [];
		for await (const e of loop.run("do it")) events.push(e);

		expect(events.some((e) => e.type === "plan_blocked")).toBe(true);
		expect(executed).toBe(false);
	});
});

describe("P0-2 hooks", () => {
	it("fires the full lifecycle", async () => {
		const seen: string[] = [];
		const hookManager = {
			async execute(event: string) {
				seen.push(event);
				return [{ success: true, stdout: "", stderr: "" }];
			},
		};
		const tools = new ToolRegistry();
		tools.register(makeTool("do_thing", async () => "result"));

		const loop = new MiMoLoop({
			client: new FakeClient([
				[toolCallChunk("do_thing", {})],
				[{ type: "content", content: "done" }],
			]),
			tools,
			workingDirectory: "/test",
			hookManager,
			maxSteps: 5,
		});

		for await (const _ of loop.run("go")) {
			/* drain */
		}

		expect(seen).toContain("UserPromptSubmit");
		expect(seen).toContain("PreToolUse");
		expect(seen).toContain("PostToolUse");
		expect(seen).toContain("Stop");
	});

	it("PreToolUse non-zero exit blocks the tool", async () => {
		let executed = false;
		const hookManager = {
			async execute(event: string) {
				if (event === "PreToolUse")
					return [{ success: false, stderr: "denied by hook" }];
				return [];
			},
		};
		const tools = new ToolRegistry();
		tools.register(
			makeTool("do_thing", async () => {
				executed = true;
				return "x";
			}),
		);

		const loop = new MiMoLoop({
			client: new FakeClient([
				[toolCallChunk("do_thing", {})],
				[{ type: "content", content: "done" }],
			]),
			tools,
			workingDirectory: "/test",
			hookManager,
			maxSteps: 5,
		});

		const events: any[] = [];
		for await (const e of loop.run("go")) events.push(e);

		expect(executed).toBe(false);
		const blocked = events.find((e) => e.type === "tool_result" && !e.success);
		expect(blocked?.result?.content).toContain("PreToolUse");
	});
});

describe("P0-3 TodoWriteTool", () => {
	it("formats the list and counts done", async () => {
		const todo = new TodoWriteTool();
		const out = await todo.execute({
			todos: [
				{ content: "a", status: "completed", activeForm: "Doing a" },
				{ content: "b", status: "in_progress", activeForm: "Doing b" },
				{ content: "c", status: "pending", activeForm: "Doing c" },
			],
		});
		expect(out).toContain("1/3 done");
		expect(out).toContain("[x] a");
		expect(out).toContain("[>] Doing b");
		expect(out).toContain("[ ] c");
	});

	it("rejects more than one in_progress", async () => {
		const todo = new TodoWriteTool();
		const out = await todo.execute({
			todos: [
				{ content: "a", status: "in_progress", activeForm: "Doing a" },
				{ content: "b", status: "in_progress", activeForm: "Doing b" },
			],
		});
		expect(out).toContain("in_progress");
	});
});

describe("P0-1 EngineBridge", () => {
	it("maps loop events to UI events", () => {
		expect(mapLoopEvent({ type: "content", content: "hi" } as any)).toEqual({
			kind: "assistant",
			text: "hi",
		});
		expect(
			mapLoopEvent({ type: "error", error: "boom", recoverable: false } as any),
		).toEqual({ kind: "error", text: "boom" });
		expect(
			mapLoopEvent({
				type: "usage",
				usage: {
					contextTokens: 8,
					totalTokens: 12,
					totalPromptTokens: 8,
					totalCompletionTokens: 4,
					totalCachedTokens: 2,
					toolCalls: 1,
					steps: 1,
					totalCost: 0,
					totalCostCurrency: "CNY",
				},
			} as any),
		).toEqual({
			kind: "usage",
			contextTokens: 8,
			totalTokens: 12,
			promptTokens: 8,
			completionTokens: 4,
			cachedTokens: 2,
			toolCalls: 1,
			steps: 1,
			totalCost: 0,
			currency: "CNY",
		});
		expect(
			mapLoopEvent({
				type: "plan_blocked",
				toolCall: { function: { name: "write_file" } },
			} as any),
		).toMatchObject({ kind: "notice", tone: "warn" });
	});

	it("streams normalized events from a loop", async () => {
		const tools = new ToolRegistry();
		const loop = new MiMoLoop({
			client: new FakeClient([[{ type: "content", content: "hello" }]]),
			tools,
			workingDirectory: "/test",
			maxSteps: 3,
		});
		const bridge = new EngineBridge(loop);

		const ui: any[] = [];
		for await (const e of bridge.send("hi")) ui.push(e);

		expect(ui.some((e) => e.kind === "assistant" && e.text === "hello")).toBe(
			true,
		);
		expect(ui.some((e) => e.kind === "done")).toBe(true);
	});
});
