import { describe, expect, it } from "vitest";
import { grammarForPath } from "../../src/tools/code-query/grammar-map.js";

describe("grammarForPath", () => {
	it(".ts maps to typescript", () => {
		expect(grammarForPath("foo.ts")).toBe("typescript");
	});

	it(".tsx maps to tsx", () => {
		expect(grammarForPath("foo.tsx")).toBe("tsx");
	});

	it(".py maps to python", () => {
		expect(grammarForPath("foo.py")).toBe("python");
	});

	it(".go maps to go", () => {
		expect(grammarForPath("a/b/c.go")).toBe("go");
	});

	it("unknown extension returns null", () => {
		expect(grammarForPath("foo.unknown")).toBeNull();
	});

	it("is case insensitive", () => {
		expect(grammarForPath("FOO.PY")).toBe("python");
	});
});
