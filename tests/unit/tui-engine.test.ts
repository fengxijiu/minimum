import { describe, expect, it } from "vitest";
import {
	buildErrorLines,
	describePermissionArgs,
	summarizeTool,
	summarizeToolResult,
	TuiConfirmationGate,
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

describe("buildErrorLines", () => {
	it("explains empty failures instead of returning no lines", () => {
		expect(buildErrorLines("T1 failed", "")).toEqual([
			"status: failed",
			"detail: no detailed output returned",
			"next: inspect the task report, logs, or upstream contract context",
		]);
	});

	it("expands a single keyword into a readable detail line", () => {
		const lines = buildErrorLines("T1 failed", "contract_invalid");
		expect(lines).toContain("status: contract_invalid");
		expect(lines.some((line) => line.includes("contract or launch requirements"))).toBe(true);
	});

	it("keeps useful multi-line stderr/report details", () => {
		const lines = buildErrorLines("exec_shell failed", "exit 1\nstderr: missing file\nhint: run npm test");
		expect(lines).toContain("status: exit 1");
		expect(lines).toContain("stderr: missing file");
		expect(lines).toContain("hint: run npm test");
	});
});

describe("TuiConfirmationGate", () => {
	it("shows choice payloads and resolves selected options", async () => {
		const gate = new TuiConfirmationGate();
		let shown = "";
		gate.onShow = (payload) => {
			shown = payload.question;
			gate.resolve({ type: "pick", optionId: "continue_w23" });
		};
		const verdict = await gate.ask({
			question: "W0.5 DAG 确认",
			options: [{ id: "continue_w23", title: "继续 W2/3" }],
			allowCustom: false,
		});
		expect(shown).toBe("W0.5 DAG 确认");
		expect(verdict).toEqual({ type: "pick", optionId: "continue_w23" });
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
