import { describe, expect, it } from "vitest";
import { extractJsonBlock, isObj } from "../../src/utils/guards.js";
import { CharBudget, CHARS_PER_TOKEN } from "../../src/utils/tokenBudget.js";

describe("isObj", () => {
	it("accepts plain objects", () => {
		expect(isObj({})).toBe(true);
		expect(isObj({ a: 1 })).toBe(true);
	});
	it("rejects null, arrays, primitives", () => {
		expect(isObj(null)).toBe(false);
		expect(isObj([])).toBe(false);
		expect(isObj("x")).toBe(false);
		expect(isObj(3)).toBe(false);
	});
});

describe("extractJsonBlock", () => {
	it("extracts and parses a tagged JSON block", () => {
		const r = extractJsonBlock(`pre <foo>{"a":1}</foo> post`, "foo");
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toEqual({ a: 1 });
	});
	it("reports a missing block", () => {
		const r = extractJsonBlock("nothing", "foo");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("missing <foo>");
	});
	it("reports invalid JSON and keeps raw", () => {
		const r = extractJsonBlock("<foo>{bad}</foo>", "foo");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain("invalid JSON in <foo>");
			expect(r.raw).toBe("{bad}");
		}
	});
	it("tolerates whitespace padding around the payload", () => {
		const r = extractJsonBlock("<foo>\n  {\"a\":1}\n</foo>", "foo");
		expect(r.ok).toBe(true);
	});
});

describe("CharBudget", () => {
	it("accepts blocks until the cap, then truncates", () => {
		const b = new CharBudget(1); // 4 chars
		expect(b.tryPush("ab")).toBe(true);
		expect(b.tryPush("cd")).toBe(true); // exactly 4
		expect(b.tryPush("e")).toBe(false); // overflow
		expect(b.truncated).toBe(true);
		expect(b.text).toBe("abcd");
	});

	it("pushAlways bypasses the cap", () => {
		const b = new CharBudget(1);
		b.pushAlways("xxxxxxxx"); // 8 chars, over the 4-char cap
		expect(b.text).toBe("xxxxxxxx");
		expect(b.truncated).toBe(false);
	});

	it("reports approxTokens from accumulated chars", () => {
		const b = new CharBudget(100);
		b.pushAlways("x".repeat(CHARS_PER_TOKEN * 3));
		expect(b.approxTokens).toBe(3);
	});
});
