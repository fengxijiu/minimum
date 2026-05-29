import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../tui/src/state/events.js";
import { reduce } from "../../tui/src/state/reducer.js";
import type { AppState } from "../../tui/src/types.js";

const base: AppState = {
	path: "/proj",
	branch: "main",
	mode: "agent",
	approvalMode: "auto-edit",
	editMode: "review",
	ctx: { used: 10, max: 200 },
	files: [],
	edits: [],
	plan: { title: "", steps: [] },
	currentStepLabel: "",
	messages: [],
	committedCount: 0,
	input: "",
	pending: null,
	helpOpen: false,
	turnInProgress: false,
	verbose: false,
	streaming: null,
	activeTool: null,
	toasts: [],
	usage: {
		promptTokens: 0,
		completionTokens: 0,
		sessionCost: 0,
		lastTurnCost: 0,
		cacheHit: 0,
	},
	mcpLoading: null,
	sessionName: null,
};

describe("TUI reducer", () => {
	it("user.submit appends a user message", () => {
		const next = reduce(base, { type: "user.submit", text: "hello" });
		expect(next.messages).toHaveLength(1);
		expect(next.messages[0]).toMatchObject({ type: "user", text: "hello" });
	});

	it("assistant.chunk accumulates streaming text", () => {
		let s = reduce(base, { type: "assistant.chunk", text: "hi " });
		s = reduce(s, { type: "assistant.chunk", text: "there" });
		expect(s.streaming).toBe("hi there");
	});

	it("assistant.final moves streaming to messages", () => {
		let s = reduce(base, { type: "assistant.chunk", text: "hello" });
		s = reduce(s, { type: "assistant.final", text: "" });
		expect(s.streaming).toBeNull();
		expect(s.messages).toHaveLength(1);
		expect(s.messages[0]).toMatchObject({ type: "assistant", text: "hello" });
	});

	it("assistant.final with explicit text uses that text", () => {
		const s = reduce(base, { type: "assistant.final", text: "explicit" });
		expect(s.messages[0]).toMatchObject({
			type: "assistant",
			text: "explicit",
		});
	});

	it("tool.start + tool.end updates tool status", () => {
		let s = reduce(base, {
			type: "tool.start",
			id: "t1",
			name: "read_file",
			args: "foo.ts",
		});
		expect(s.messages).toHaveLength(1);
		expect(s.messages[0]).toMatchObject({ type: "tool" });
		s = reduce(s, { type: "tool.end", id: "t1", ok: true, meta: "48 ln" });
		expect(s.messages[0]).toMatchObject({
			type: "tool",
			tool: { status: "ok", meta: "48 ln" },
		});
	});

	it("permission.show sets pending", () => {
		const s = reduce(base, {
			type: "permission.show",
			perm: { tool: "run shell", cmd: "$ ls", cwd: "/proj", note: "safe" },
		});
		expect(s.pending).toBe("permission");
		expect(s.messages).toHaveLength(1);
		expect(s.messages[0]).toMatchObject({ type: "permission" });
	});

	it("session.clear resets messages, edits, plan, streaming", () => {
		const dirty: AppState = {
			...base,
			messages: [{ id: "x", type: "user", text: "hi" }],
			edits: [{ sign: "+", label: "foo.ts" }],
			streaming: "partial...",
			pending: "error",
		};
		const s = reduce(dirty, { type: "session.clear" });
		expect(s.messages).toEqual([]);
		expect(s.edits).toEqual([]);
		expect(s.streaming).toBeNull();
		expect(s.pending).toBeNull();
	});

	it("messages.clear only clears messages", () => {
		const dirty: AppState = {
			...base,
			messages: [{ id: "x", type: "user", text: "hi" }],
			edits: [{ sign: "+", label: "foo.ts" }],
		};
		const s = reduce(dirty, { type: "messages.clear" });
		expect(s.messages).toEqual([]);
		expect(s.edits).toHaveLength(1); // preserved
	});

	it("mode.change toggles mode", () => {
		const s = reduce(base, { type: "mode.change", mode: "chat" });
		expect(s.mode).toBe("chat");
	});

	it("approval.change updates approval mode", () => {
		const s = reduce(base, { type: "approval.change", mode: "full-auto" });
		expect(s.approvalMode).toBe("full-auto");
	});

	it("plan.set updates plan and currentStepLabel", () => {
		const s = reduce(base, {
			type: "plan.set",
			title: "test plan",
			steps: [
				{ label: "step 1", status: "done" },
				{ label: "step 2", status: "now" },
				{ label: "step 3", status: "next" },
			],
		});
		expect(s.plan.title).toBe("test plan");
		expect(s.plan.steps).toHaveLength(3);
		expect(s.currentStepLabel).toContain("STEP 2");
		expect(s.currentStepLabel).toContain("STEP 2");
	});

	it("plan.step.update advances step", () => {
		const withPlan = reduce(base, {
			type: "plan.set",
			title: "t",
			steps: [
				{ label: "a", status: "now" },
				{ label: "b", status: "next" },
			],
		});
		const s = reduce(withPlan, {
			type: "plan.step.update",
			index: 0,
			status: "done",
		});
		expect(s.plan.steps[0]?.status).toBe("done");
	});

	it("edit.add appends to edits", () => {
		const s = reduce(base, {
			type: "edit.add",
			edit: { sign: "+", label: "foo.ts · bar" },
		});
		expect(s.edits).toHaveLength(1);
	});

	it("edit.remove removes by index", () => {
		const withEdits = reduce(base, {
			type: "edit.add",
			edit: { sign: "+", label: "a" },
		});
		const s = reduce(withEdits, { type: "edit.remove", index: 0 });
		expect(s.edits).toHaveLength(0);
	});

	it("turn.start sets turnInProgress and streaming", () => {
		const s = reduce(base, { type: "turn.start" });
		expect(s.turnInProgress).toBe(true);
		expect(s.streaming).toBe("");
	});

	it("turn.end clears turnInProgress and streaming", () => {
		const running = reduce(base, { type: "turn.start" });
		const s = reduce(running, { type: "turn.end", success: true });
		expect(s.turnInProgress).toBe(false);
		expect(s.streaming).toBeNull();
	});

	it("help.toggle flips helpOpen", () => {
		const s1 = reduce(base, { type: "help.toggle" });
		expect(s1.helpOpen).toBe(true);
		const s2 = reduce(s1, { type: "help.toggle" });
		expect(s2.helpOpen).toBe(false);
	});

	it("ctx.update changes used tokens", () => {
		const s = reduce(base, { type: "ctx.update", used: 42.5 });
		expect(s.ctx.used).toBe(42.5);
		expect(s.ctx.max).toBe(200); // preserved
	});

	it("ctx.update can change max", () => {
		const s = reduce(base, { type: "ctx.update", used: 50, max: 128 });
		expect(s.ctx.max).toBe(128);
	});

	it("error.push appends error message", () => {
		const s = reduce(base, {
			type: "error.push",
			title: "ERR",
			lines: ["line 1"],
		});
		expect(s.messages).toHaveLength(1);
		expect(s.messages[0]).toMatchObject({
			type: "error",
			error: { title: "ERR", lines: ["line 1"] },
		});
	});

	it("input.change updates input", () => {
		const s = reduce(base, { type: "input.change", value: "/help" });
		expect(s.input).toBe("/help");
	});

	it("input.submit clears input", () => {
		const withInput = reduce(base, { type: "input.change", value: "hello" });
		const s = reduce(withInput, { type: "input.submit" });
		expect(s.input).toBe("");
	});

	it("tool.start sets activeTool", () => {
		const s = reduce(base, {
			type: "tool.start",
			id: "t1",
			name: "read_file",
			args: "foo.ts",
		});
		expect(s.activeTool).not.toBeNull();
		expect(s.activeTool?.name).toBe("read_file");
		expect(s.activeTool?.status).toBe("running");
	});

	it("tool.end updates activeTool status", () => {
		let s = reduce(base, {
			type: "tool.start",
			id: "t1",
			name: "read_file",
			args: "foo.ts",
		});
		s = reduce(s, { type: "tool.end", id: "t1", ok: true, meta: "48 ln" });
		expect(s.activeTool?.status).toBe("ok");
		expect(s.activeTool?.meta).toBe("48 ln");
	});

	it("tool.end with ok=false sets err status", () => {
		let s = reduce(base, {
			type: "tool.start",
			id: "t1",
			name: "exec_shell",
			args: "pytest",
		});
		s = reduce(s, { type: "tool.end", id: "t1", ok: false, meta: "exit 1" });
		expect(s.activeTool?.status).toBe("err");
	});

	it("turn.end clears activeTool", () => {
		let s = reduce(base, {
			type: "tool.start",
			id: "t1",
			name: "read_file",
			args: "foo.ts",
		});
		s = reduce(s, { type: "turn.end", success: true });
		expect(s.activeTool).toBeNull();
	});

	it("tool.end for non-matching id preserves activeTool", () => {
		let s = reduce(base, {
			type: "tool.start",
			id: "t1",
			name: "read_file",
			args: "foo.ts",
		});
		s = reduce(s, { type: "tool.end", id: "t2", ok: true });
		expect(s.activeTool?.id).toBe("t1");
		expect(s.activeTool?.status).toBe("running");
	});

	it("streaming chunks accumulate then finalize", () => {
		let s = reduce(base, { type: "turn.start" });
		s = reduce(s, { type: "assistant.chunk", text: "Hello " });
		s = reduce(s, { type: "assistant.chunk", text: "world" });
		expect(s.streaming).toBe("Hello world");
		expect(s.turnInProgress).toBe(true);
		s = reduce(s, { type: "assistant.final", text: "" });
		expect(s.streaming).toBeNull();
		expect(s.messages).toHaveLength(1);
		expect(s.messages[0]).toMatchObject({
			type: "assistant",
			text: "Hello world",
		});
	});

	// ── toast ─────────────────────────────────────────────────────
	it("toast.show adds a toast", () => {
		const s = reduce(base, { type: "toast.show", text: "hello", tone: "info" });
		expect(s.toasts).toHaveLength(1);
		expect(s.toasts[0]?.text).toBe("hello");
		expect(s.toasts[0]?.tone).toBe("info");
	});

	it("toast.dismiss removes a toast", () => {
		let s = reduce(base, { type: "toast.show", text: "x", tone: "ok" });
		const id = s.toasts[0]?.id;
		s = reduce(s, { type: "toast.dismiss", id });
		expect(s.toasts).toHaveLength(0);
	});

	// ── usage ─────────────────────────────────────────────────────
	it("usage.update tracks cost", () => {
		const s = reduce(base, {
			type: "usage.update",
			promptTokens: 100,
			completionTokens: 50,
			cost: 0.005,
		});
		expect(s.usage.promptTokens).toBe(100);
		expect(s.usage.completionTokens).toBe(50);
		expect(s.usage.sessionCost).toBe(0.005);
		expect(s.usage.lastTurnCost).toBe(0.005);
	});

	it("usage.update accumulates session cost", () => {
		let s = reduce(base, { type: "usage.update", cost: 0.01 });
		s = reduce(s, { type: "usage.update", cost: 0.02 });
		expect(s.usage.sessionCost).toBeCloseTo(0.03);
	});

	// ── edit mode ─────────────────────────────────────────────────
	it("edit.mode.change updates editMode", () => {
		const s = reduce(base, { type: "edit.mode.change", mode: "auto" });
		expect(s.editMode).toBe("auto");
	});

	it("edit.undo removes last edit and shows toast", () => {
		const withEdits = reduce(base, {
			type: "edit.add",
			edit: { sign: "+", label: "foo.ts" },
		});
		const s = reduce(withEdits, { type: "edit.undo" });
		expect(s.edits).toHaveLength(0);
		expect(s.toasts).toHaveLength(1);
		expect(s.toasts[0]?.text).toContain("foo.ts");
	});

	it("edit.undo on empty edits is no-op", () => {
		const s = reduce(base, { type: "edit.undo" });
		expect(s.edits).toHaveLength(0);
		expect(s.toasts).toHaveLength(0);
	});

	// ── mcp ───────────────────────────────────────────────────────
	it("mcp.loading sets loading state", () => {
		const s = reduce(base, { type: "mcp.loading", ready: 1, total: 3 });
		expect(s.mcpLoading).toEqual({ ready: 1, total: 3 });
	});

	it("mcp.loading with total=0 clears loading", () => {
		let s = reduce(base, { type: "mcp.loading", ready: 3, total: 3 });
		s = reduce(s, { type: "mcp.loading", ready: 0, total: 0 });
		expect(s.mcpLoading).toBeNull();
	});

	// ── verbose ───────────────────────────────────────────────────
	it("verbose.toggle flips verbose flag", () => {
		const s1 = reduce(base, { type: "verbose.toggle" });
		expect(s1.verbose).toBe(true);
		const s2 = reduce(s1, { type: "verbose.toggle" });
		expect(s2.verbose).toBe(false);
	});

	// ── session.load ──────────────────────────────────────────────
	it("session.load sets session name", () => {
		const s = reduce(base, { type: "session.load", name: "my-session" });
		expect(s.sessionName).toBe("my-session");
		expect(s.messages).toHaveLength(0);
	});

	// ── session.reset ─────────────────────────────────────────────
	it("session.reset clears usage", () => {
		const withUsage = reduce(base, { type: "usage.update", cost: 0.5 });
		const s = reduce(withUsage, { type: "session.reset" });
		expect(s.usage.sessionCost).toBe(0);
		expect(s.messages).toHaveLength(0);
		expect(s.edits).toHaveLength(0);
	});

	// ── init ──────────────────────────────────────────────────────
	it("init.run is a no-op in reducer", () => {
		const s = reduce(base, { type: "init.run", cwd: "/proj" });
		expect(s).toBe(base); // same reference — no state change
	});

	// ── Phase 2: Static double-buffer commit ─────────────────────────
	it("messages.commit advances committedCount to current message length", () => {
		let s = reduce(base, { type: "user.submit", text: "hello" });
		s = reduce(s, { type: "assistant.final", text: "hi" });
		expect(s.committedCount).toBe(0); // not committed yet
		s = reduce(s, { type: "messages.commit" });
		expect(s.committedCount).toBe(2); // user + assistant
		expect(s.messages).toHaveLength(2); // messages still present for history
	});

	it("messages.commit is idempotent when called twice", () => {
		let s = reduce(base, { type: "user.submit", text: "hello" });
		s = reduce(s, { type: "messages.commit" });
		const count = s.committedCount;
		s = reduce(s, { type: "messages.commit" });
		expect(s.committedCount).toBe(count);
	});

	it("messages.clear resets committedCount to 0", () => {
		let s = reduce(base, { type: "user.submit", text: "hi" });
		s = reduce(s, { type: "messages.commit" });
		s = reduce(s, { type: "messages.clear" });
		expect(s.messages).toHaveLength(0);
		expect(s.committedCount).toBe(0);
	});

	it("session.clear resets committedCount", () => {
		let s = reduce(base, { type: "user.submit", text: "hi" });
		s = reduce(s, { type: "messages.commit" });
		s = reduce(s, { type: "session.clear" });
		expect(s.committedCount).toBe(0);
	});

	it("session.reset resets committedCount", () => {
		let s = reduce(base, { type: "user.submit", text: "hi" });
		s = reduce(s, { type: "messages.commit" });
		s = reduce(s, { type: "session.reset" });
		expect(s.committedCount).toBe(0);
	});

	it("new messages after commit appear in live tail (index >= committedCount)", () => {
		let s = reduce(base, { type: "user.submit", text: "turn 1" });
		s = reduce(s, { type: "assistant.final", text: "reply 1" });
		s = reduce(s, { type: "messages.commit" }); // committedCount = 2
		s = reduce(s, { type: "user.submit", text: "turn 2" });
		expect(s.committedCount).toBe(2);
		expect(s.messages).toHaveLength(3);
		// live tail = messages.slice(2) = [turn 2 message]
		expect(s.messages.slice(s.committedCount)).toHaveLength(1);
		expect(s.messages[2]).toMatchObject({ type: "user", text: "turn 2" });
	});
});
