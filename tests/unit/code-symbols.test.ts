import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSymbols } from "../../src/tools/code-query/symbols.js";

describe("extractSymbols", () => {
	it("extracts top-level TypeScript symbols", async () => {
		const file = resolve("tests/fixtures/sample.ts");
		const source = await readFile(file, "utf8");
		const symbols = await extractSymbols(file, source);

		expect(symbols.some((s) => s.name === "topLevel" && s.kind === "function")).toBe(true);
		expect(symbols.some((s) => s.name === "Foo" && s.kind === "class")).toBe(true);
		expect(symbols.some((s) => s.name === "Iface" && s.kind === "interface")).toBe(true);
		expect(symbols.some((s) => s.name === "Alias" && s.kind === "type")).toBe(true);
		expect(symbols.some((s) => s.name === "Color" && s.kind === "enum")).toBe(true);
	});

	it("promotes class methods to method kind", async () => {
		const file = resolve("tests/fixtures/sample.ts");
		const source = await readFile(file, "utf8");
		const symbols = await extractSymbols(file, source);
		const method = symbols.find((s) => s.name === "bar");
		expect(method?.kind).toBe("method");
		expect(method?.parent).toBe("Foo");
	});

	it("extracts Python class and function symbols", async () => {
		const file = resolve("tests/fixtures/sample.py");
		const source = await readFile(file, "utf8");
		const symbols = await extractSymbols(file, source);

		expect(symbols.some((s) => s.name === "top_level" && s.kind === "function")).toBe(true);
		expect(symbols.some((s) => s.name === "MyClass" && s.kind === "class")).toBe(true);
		expect(symbols.some((s) => s.name === "method" && s.kind === "method")).toBe(true);
	});

	it("returns [] for unsupported files", async () => {
		expect(await extractSymbols("notes.txt", "hello")).toEqual([]);
	});
});
