import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findInCode } from "../../src/tools/code-query/find-in-code.js";

describe("findInCode", () => {
	it("finds definitions", async () => {
		const file = resolve("tests/fixtures/sample.ts");
		const source = await readFile(file, "utf8");
		const matches = await findInCode(file, source, "topLevel", { kind: "definition" });
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("definition");
	});

	it("finds references and calls separately", async () => {
		const file = resolve("tests/fixtures/sample.ts");
		const source = `${await readFile(file, "utf8")}\nconst x = topLevel();\nconst y = Foo;\n`;
		const callMatches = await findInCode(file, source, "topLevel", { kind: "call" });
		const refMatches = await findInCode(file, source, "Foo", { kind: "reference" });
		expect(callMatches.some((m) => m.kind === "call")).toBe(true);
		expect(refMatches.some((m) => m.kind === "reference")).toBe(true);
	});

	it("skips identifiers in comments and strings", async () => {
		const file = resolve("tests/fixtures/sample.ts");
		const source = '// topLevel\\nconst msg = "topLevel";\n';
		const matches = await findInCode(file, source, "topLevel");
		expect(matches).toEqual([]);
	});

	it("returns [] for empty name", async () => {
		const file = resolve("tests/fixtures/sample.ts");
		const source = await readFile(file, "utf8");
		expect(await findInCode(file, source, "")).toEqual([]);
	});

	it("returns [] for unsupported files", async () => {
		expect(await findInCode("notes.txt", "abc", "abc")).toEqual([]);
	});
});
