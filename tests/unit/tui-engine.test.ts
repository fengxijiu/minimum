import { describe, expect, it } from "vitest";
import {
	buildErrorLines,
	describePermissionArgs,
	PermissionQueue,
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

	it("queues concurrent asks and shows them one at a time in FIFO order", async () => {
		const gate = new TuiConfirmationGate();
		const shown: string[] = [];
		gate.onShow = (payload) => {
			shown.push(payload.question);
		};

		const p1 = gate.ask({ question: "Q1", options: [{ id: "a", title: "A" }], allowCustom: false });
		const p2 = gate.ask({ question: "Q2", options: [{ id: "b", title: "B" }], allowCustom: false });

		// Only the first prompt is on screen; the second waits in the queue.
		expect(shown).toEqual(["Q1"]);
		expect(gate.pending).toBe(2);

		gate.resolve({ type: "pick", optionId: "a" });
		// Answering the first surfaces the second.
		expect(shown).toEqual(["Q1", "Q2"]);
		expect(gate.pending).toBe(1);

		gate.resolve({ type: "pick", optionId: "b" });
		expect(gate.pending).toBe(0);

		await expect(p1).resolves.toEqual({ type: "pick", optionId: "a" });
		await expect(p2).resolves.toEqual({ type: "pick", optionId: "b" });
	});

	it("does not orphan an earlier ask when a second arrives mid-flight", async () => {
		const gate = new TuiConfirmationGate();
		gate.onShow = () => {};
		let p1Settled = false;
		const p1 = gate.ask({ question: "first", options: [{ id: "a", title: "A" }], allowCustom: false });
		void p1.then(() => {
			p1Settled = true;
		});
		gate.ask({ question: "second", options: [{ id: "b", title: "B" }], allowCustom: false });

		gate.resolve({ type: "pick", optionId: "a" });
		expect(await p1).toEqual({ type: "pick", optionId: "a" });
		expect(p1Settled).toBe(true);
	});

	it("ignores resolve() when no prompt is active", () => {
		const gate = new TuiConfirmationGate();
		expect(() => gate.resolve({ type: "cancel" })).not.toThrow();
		expect(gate.pending).toBe(0);
	});
});

describe("PermissionQueue", () => {
	type Perm = { id: string };

	it("shows the first request and queues the rest FIFO", () => {
		const q = new PermissionQueue<Perm>();
		expect(q.submit({ id: "a" })).toEqual({ id: "a" }); // shown now
		expect(q.submit({ id: "b" })).toBeNull(); // queued
		expect(q.submit({ id: "c" })).toBeNull(); // queued
		expect(q.current).toEqual({ id: "a" });
		expect(q.pending).toBe(3);

		expect(q.next()).toEqual({ id: "b" });
		expect(q.current).toEqual({ id: "b" });
		expect(q.pending).toBe(2);

		expect(q.next()).toEqual({ id: "c" });
		expect(q.next()).toBeNull();
		expect(q.current).toBeNull();
		expect(q.pending).toBe(0);
	});

	it("drain returns the active request plus everything queued, in order", () => {
		const q = new PermissionQueue<Perm>();
		q.submit({ id: "a" });
		q.submit({ id: "b" });
		q.submit({ id: "c" });
		expect(q.drain()).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
		expect(q.pending).toBe(0);
		expect(q.current).toBeNull();
		// After draining, a new submit shows immediately again.
		expect(q.submit({ id: "d" })).toEqual({ id: "d" });
	});

	it("clear empties without returning anything", () => {
		const q = new PermissionQueue<Perm>();
		q.submit({ id: "a" });
		q.submit({ id: "b" });
		q.clear();
		expect(q.pending).toBe(0);
		expect(q.current).toBeNull();
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
