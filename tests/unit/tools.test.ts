import { beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";
import { ReadFileTool } from "../../src/tools/filesystem/ReadFileTool.js";
import { ExecShellTool } from "../../src/tools/shell/ExecShellTool.js";

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
					arguments: '{"command": "echo hello"}',
				},
			});

			expect(result.content).toContain("hello");
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
			const result = await tool.execute({ command: "echo test" });

			expect(result).toContain("test");
		});
	});
});
