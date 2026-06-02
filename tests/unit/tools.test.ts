import { beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";
import { ReadFileTool } from "../../src/tools/filesystem/ReadFileTool.js";
import { ExecShellTool } from "../../src/tools/shell/ExecShellTool.js";
import { ToolRateLimiter } from "../../src/tools/index.js";
import {
	ChoiceTool,
	DeferredConfirmationGate,
	ReadTracker,
} from "../../src/tools/index.js";

describe("Tools", () => {
	describe("ToolRegistry", () => {
		let registry: ToolRegistry;

		beforeEach(() => {
			registry = new ToolRegistry();
		});

		it("should register tool", () => {
			const tool = new ReadFileTool();
			registry.register(tool);

			expect(registry.has("read_file")).toBe(true);
		});

		it("should get tool definitions", () => {
			registry.register(new ReadFileTool());
			registry.register(new ExecShellTool());

			const definitions = registry.getDefinitions();
			expect(definitions.length).toBe(2);
		});

		it("should unregister tool", () => {
			registry.register(new ReadFileTool());
			expect(registry.has("read_file")).toBe(true);

			registry.unregister("read_file");
			expect(registry.has("read_file")).toBe(false);
		});

		it("should get tool", () => {
			registry.register(new ReadFileTool());
			const tool = registry.get("read_file");

			expect(tool).toBeDefined();
			expect(tool?.name).toBe("read_file");
		});

		it("should get all tools", () => {
			registry.register(new ReadFileTool());
			registry.register(new ExecShellTool());

			const tools = registry.getAll();
			expect(tools.length).toBe(2);
		});

		it("should handle unknown tool execution", async () => {
			const result = await registry.execute({
				function: {
					name: "unknown_tool",
					arguments: "{}",
				},
			});

			expect(result.isError).toBe(true);
			expect(result.content).toContain("Unknown tool");
		});

		it("should execute registered tool", async () => {
			const tool = new ExecShellTool();
			registry.register(tool);

			const result = await registry.execute({
				function: {
					name: "exec_shell",
					arguments: JSON.stringify({ command: "node --version" }),
				},
			});

			expect(result.content).toMatch(/v\d+/);
		});

		it("rate limiter 短路时返回限流结构体且不调用工具", async () => {
			const limiter = new ToolRateLimiter({
				aggregate: { maxCalls: 1, windowSeconds: 60 },
			});
			const registry = new ToolRegistry({ rateLimiter: limiter });
			registry.register(new ExecShellTool());
			// First call: allowed (uses the 1-call budget)
			const ok = await registry.execute({
				function: { name: "exec_shell", arguments: JSON.stringify({ command: "node --version" }) },
			});
			expect(ok.isError).toBeFalsy();
			// Second call: rate-limited
			const blocked = await registry.execute({
				function: { name: "exec_shell", arguments: JSON.stringify({ command: "node -v" }) },
			});
			expect(blocked.isError).toBe(true);
			expect(blocked.content).toContain("rate_limited");
		});
	});

	describe("ReadFileTool", () => {
		it("should have correct name", () => {
			const tool = new ReadFileTool();
			expect(tool.name).toBe("read_file");
		});

		it("should have definition", () => {
			const tool = new ReadFileTool();
			const definition = tool.getDefinition();

			expect(definition).toBeDefined();
			expect(definition.name).toBe("read_file");
			expect(definition.parameters).toBeDefined();
		});
	});

	describe("ExecShellTool", () => {
		it("should have correct name", () => {
			const tool = new ExecShellTool();
			expect(tool.name).toBe("exec_shell");
		});

		it("should have definition", () => {
			const tool = new ExecShellTool();
			const definition = tool.getDefinition();

			expect(definition).toBeDefined();
			expect(definition.name).toBe("exec_shell");
			expect(definition.parameters).toBeDefined();
		});

		it("should execute command", async () => {
			const tool = new ExecShellTool();
			const result = await tool.execute({ command: "node --version" });

			expect(result).toMatch(/v\d+/);
		});
	});
});

describe("Wave1 集成 smoke", () => {
	it("从 index barrel 拿到的导出可用", async () => {
		const reg = new ToolRegistry({
			rateLimiter: new ToolRateLimiter({ aggregate: { maxCalls: 1000, windowSeconds: 60 } }),
		});
		const gate = new DeferredConfirmationGate();
		gate.resolve({ type: "pick", optionId: "yes" });
		reg.register(new ChoiceTool({ gate }) as any);
		// ReadTracker just needs to be constructible
		const tracker = new ReadTracker();
		expect(tracker.hasRead("/any")).toBe(false);
		const res = await reg.execute({
			function: {
				name: "ask_choice",
				arguments: JSON.stringify({
					question: "Proceed?",
					options: [
						{ id: "yes", title: "Yes" },
						{ id: "no", title: "No" },
					],
				}),
			},
		});
		expect(res.content).toBe("user picked: yes");
		expect(res.isError).toBeFalsy();
	});
});
