import { ToolRegistry } from "../../src/tools/ToolRegistry";
import { GrepTool, SearchTool } from "../../src/tools/search/GrepTool";

describe("ToolRegistry", () => {
	let registry: ToolRegistry;

	beforeEach(() => {
		registry = new ToolRegistry();
	});

	describe("register and get", () => {
		it("should register and retrieve a tool", () => {
			const tool = new GrepTool();
			registry.register(tool);

			expect(registry.get("grep")).toBe(tool);
			expect(registry.has("grep")).toBe(true);
		});

		it("should return undefined for unregistered tool", () => {
			expect(registry.get("nonexistent")).toBeUndefined();
			expect(registry.has("nonexistent")).toBe(false);
		});
	});

	describe("unregister", () => {
		it("should unregister a tool", () => {
			const tool = new GrepTool();
			registry.register(tool);

			expect(registry.unregister("grep")).toBe(true);
			expect(registry.get("grep")).toBeUndefined();
			expect(registry.has("grep")).toBe(false);
		});

		it("should return false when unregistering nonexistent tool", () => {
			expect(registry.unregister("nonexistent")).toBe(false);
		});
	});

	describe("getAll", () => {
		it("should return all registered tools", () => {
			const grepTool = new GrepTool();
			const searchTool = new SearchTool();

			registry.register(grepTool);
			registry.register(searchTool);

			const tools = registry.getAll();
			expect(tools).toHaveLength(2);
			expect(tools).toContain(grepTool);
			expect(tools).toContain(searchTool);
		});
	});

	describe("getDefinitions", () => {
		it("should return tool definitions", () => {
			const grepTool = new GrepTool();
			registry.register(grepTool);

			const definitions = registry.getDefinitions();
			expect(definitions).toHaveLength(1);
			expect(definitions[0].name).toBe("grep");
			expect(definitions[0].parameters).toBeDefined();
		});
	});

	describe("execute", () => {
		it("should execute a tool", async () => {
			const grepTool = new GrepTool();
			registry.register(grepTool);

			const result = await registry.execute({
				function: {
					name: "grep",
					arguments: JSON.stringify({ pattern: "test" }),
				},
			});

			expect(result.content).toBeDefined();
			expect(result.isError).toBeUndefined();
		});

		it("should return error for unknown tool", async () => {
			const result = await registry.execute({
				function: {
					name: "unknown",
					arguments: "{}",
				},
			});

			expect(result.content).toBe("Unknown tool: unknown");
			expect(result.isError).toBe(true);
		});

		it("should return error for invalid arguments", async () => {
			const grepTool = new GrepTool();
			registry.register(grepTool);

			const result = await registry.execute({
				function: {
					name: "grep",
					arguments: "invalid json",
				},
			});

			expect(result.content).toContain("Tool execution failed");
			expect(result.isError).toBe(true);
		});
	});
});

describe("GrepTool", () => {
	let grepTool: GrepTool;

	beforeEach(() => {
		grepTool = new GrepTool();
	});

	it("should have correct name and description", () => {
		expect(grepTool.name).toBe("grep");
		expect(grepTool.description).toBe("Search for patterns in files");
	});

	it("should return definition with required parameters", () => {
		const definition = grepTool.getDefinition();
		expect(definition.name).toBe("grep");
		expect(definition.parameters?.required).toContain("pattern");
	});

	it("should execute with pattern", async () => {
		const result = await grepTool.execute({ pattern: "test" });
		expect(typeof result).toBe("string");
	});
});

describe("SearchTool", () => {
	let searchTool: SearchTool;

	beforeEach(() => {
		searchTool = new SearchTool();
	});

	it("should have correct name and description", () => {
		expect(searchTool.name).toBe("search");
		expect(searchTool.description).toBe("Search for files and content");
	});

	it("should return definition with required parameters", () => {
		const definition = searchTool.getDefinition();
		expect(definition.name).toBe("search");
		expect(definition.parameters?.required).toContain("query");
	});

	it("should execute with query", async () => {
		const result = await searchTool.execute({ query: "test" });
		expect(typeof result).toBe("string");
	});
});
