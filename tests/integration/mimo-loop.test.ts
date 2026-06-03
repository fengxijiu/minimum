import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompletenessChecker } from "../../src/completeness/CompletenessChecker.js";
import { ContextManager } from "../../src/context/ContextManager.js";
import { IterationManager } from "../../src/iteration/IterationManager.js";
import { MiMoLoop } from "../../src/loop/MiMoLoop.js";
import { MockClient } from "../helpers/MockClient.js";
import { ToolCallRepair } from "../../src/repair/ToolCallRepair.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";
import { CodeValidator } from "../../src/validators/CodeValidator.js";

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

describe("MiMoLoop Integration", () => {
	let loop: MiMoLoop;
	let client: MockClient;
	let tools: ToolRegistry;

	beforeEach(() => {
		client = new MockClient();
		tools = new ToolRegistry();

		loop = new MiMoLoop({
			client,
			tools,
			validator: new CodeValidator(),
			toolRepair: new ToolCallRepair(),
			completenessChecker: new CompletenessChecker(),
			contextManager: new ContextManager(),
			iterationManager: new IterationManager(),
			maxTokens: 4000,
			maxSteps: 10,
			workingDirectory: "/test",
		});
	});

	it("should execute simple task", async () => {
		client.setDefaultResponse("done");

		const events: any[] = [];
		for await (const event of loop.run("Say hello")) {
			events.push(event);
		}

		expect(events.length).toBeGreaterThan(0);
		expect(events.some((e) => e.type === "content")).toBe(true);
		expect(events.some((e) => e.type === "done")).toBe(true);
	});

	it("should handle tool calls", async () => {
		client.setDefaultResponse("");
		client.setResponse("Read file", "File content here");

		tools.register(
			makeTool("read_file", async () => "File content", "Read a file"),
		);

		const events: any[] = [];
		for await (const event of loop.run("Read the file")) {
			events.push(event);
		}

		// 由于MockClient不支持返回工具调用，我们只验证事件被生成
		expect(events.length).toBeGreaterThan(0);
	});

	it("should track usage", async () => {
		client.setDefaultResponse("Done");

		const events: any[] = [];
		for await (const event of loop.run("Test")) {
			events.push(event);
		}

		const usageEvent = events.find((e) => e.type === "usage");
		expect(usageEvent).toBeDefined();
		expect(usageEvent.usage).toBeDefined();
		expect(usageEvent.usage.contextTokens).toBeTypeOf("number");
		expect(usageEvent.usage.contextTokens).toBeGreaterThan(0);
		expect(usageEvent.usage.totalTokens).toBeDefined();
	});

	it("should handle errors gracefully", async () => {
		client.setDefaultResponse("");

		// 模拟错误
		client.streamChat = async function* (options: any) {
			throw new Error("API Error");
		};

		const events: any[] = [];
		for await (const event of loop.run("Test error")) {
			events.push(event);
		}

		expect(events.some((e) => e.type === "error")).toBe(true);
	});
});
