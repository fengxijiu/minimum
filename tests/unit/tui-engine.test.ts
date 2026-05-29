import { describe, expect, it } from "vitest";
import {
	describePermissionArgs,
	summarizeTool,
	summarizeToolResult,
} from "../../tui/src/engine.js";

describe("summarizeTool", () => {
	it("formats read_file with line range", () => {
		expect(
			summarizeTool("read_file", JSON.stringify({ path: "src/app.ts", start_line: 1, end_line: 80 })),
		).toBe("src/app.ts:1–80");
	});

	it("formats grep pattern and path", () => {
		expect(summarizeTool("grep", JSON.stringify({ pattern: "useState", path: "src/" }))).toBe(
			'"useState" in src/',
		);
	});

	it("falls back to truncated raw args on bad JSON", () => {
		expect(summarizeTool("unknown", "not json")).toBe("not json");
	});
});

describe("summarizeToolResult", () => {
	it("returns empty string on failure", () => {
		expect(summarizeToolResult(false, "anything")).toBe("");
	});

	it("counts added/removed lines", () => {
		expect(summarizeToolResult(true, "+a\n+b\n-c")).toBe("+2 −1");
	});

	it("reports line count for plain multi-line output", () => {
		expect(summarizeToolResult(true, "one\ntwo\nthree")).toBe("3 ln");
	});

	it("surfaces exit code", () => {
		expect(summarizeToolResult(true, "ran\nexit 0")).toBe("exit 0");
	});
});

describe("describePermissionArgs", () => {
	it("orders priority keys first and lists each parameter", () => {
		const lines = describePermissionArgs({ timeout: 30, command: "rm -rf x" });
		expect(lines[0]).toBe("command: rm -rf x");
		expect(lines).toContain("timeout: 30");
	});

	it("summarizes large content by length instead of dumping it", () => {
		const lines = describePermissionArgs({ content: "x".repeat(200) });
		expect(lines[0]).toBe("content: 200 chars");
	});

	it("truncates long values", () => {
		const lines = describePermissionArgs({ path: "a".repeat(100) });
		expect(lines[0]!.endsWith("…")).toBe(true);
		expect(lines[0]!.length).toBeLessThanOrEqual("path: ".length + 72 + 1);
	});

	it("caps at 8 lines", () => {
		const args: Record<string, number> = {};
		for (let i = 0; i < 20; i++) args[`k${i}`] = i;
		expect(describePermissionArgs(args).length).toBe(8);
	});
});
