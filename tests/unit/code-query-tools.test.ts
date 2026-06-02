import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeQueryTool } from "../../src/tools/code-query/CodeQueryTool.js";
import { SymbolsTool } from "../../src/tools/code-query/SymbolsTool.js";

describe("code-query tools", () => {
	it("get_symbols returns symbols for fixture file", async () => {
		const tool = new SymbolsTool();
		const result = await tool.execute(
			{ path: "tests/fixtures/sample.ts" },
			{ workingDirectory: process.cwd() },
		);
		const parsed = JSON.parse(result) as { path: string; symbols: Array<{ name: string }> };
		expect(parsed.path).toBe("tests/fixtures/sample.ts");
		expect(parsed.symbols.some((s) => s.name === "Foo")).toBe(true);
	});

	it("find_in_code returns AST-filtered matches", async () => {
		const tool = new CodeQueryTool();
		const result = await tool.execute(
			{ path: "tests/fixtures/sample.ts", name: "topLevel", kind: "definition" },
			{ workingDirectory: process.cwd() },
		);
		const parsed = JSON.parse(result) as { matches: Array<{ kind: string }> };
		expect(parsed.matches).toHaveLength(1);
		expect(parsed.matches[0]?.kind).toBe("definition");
	});

	it("unsupported file returns error payload", async () => {
		const tool = new SymbolsTool();
		const result = await tool.execute(
			{ path: "README.md" },
			{ workingDirectory: process.cwd() },
		);
		const parsed = JSON.parse(result) as { error?: string };
		expect(parsed.error).toContain("language not supported");
	});

	it("resolves absolute paths too", async () => {
		const tool = new CodeQueryTool();
		const absolute = resolve("tests/fixtures/sample.ts");
		const result = await tool.execute({ path: absolute, name: "Foo" });
		const parsed = JSON.parse(result) as { matches: Array<{ kind: string }> };
		expect(parsed.matches.length).toBeGreaterThan(0);
	});
});
