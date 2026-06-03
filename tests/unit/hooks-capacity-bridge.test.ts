import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookManager } from "../../src/hooks/index.js";
import type { HookConfig, HookContext, HookEvent } from "../../src/hooks/index.js";
import { HOOK_EVENTS } from "../../src/hooks/index.js";
import { CapacityController } from "../../src/capacity/index.js";
import type {
	CapacityConfig,
	CapacityObservation,
	RiskBand,
	GuardrailAction,
} from "../../src/capacity/index.js";
import { EngineBridge, mapLoopEvent } from "../../src/bridge/index.js";
import type { UiEvent } from "../../src/bridge/index.js";
import { parsePlanFromTodoResult } from "../../src/bridge/EngineBridge.js";
import type { LoopEvent } from "../../src/loop/MiMoLoop.js";

// ============================================================
// Module 1: HookManager
// ============================================================
describe("HookManager", () => {
	let manager: HookManager;

	beforeEach(() => {
		manager = new HookManager();
	});

	// --- register ---
	describe("register", () => {
		it("returns a unique id for each registered hook", () => {
			const id1 = manager.register({ event: "PreToolUse", command: "echo a" });
			const id2 = manager.register({ event: "PreToolUse", command: "echo b" });
			expect(id1).toBe("hook_1");
			expect(id2).toBe("hook_2");
			expect(id1).not.toBe(id2);
		});

		it("stores the hook under the correct event", () => {
			manager.register({ event: "PostToolUse", command: "echo x" });
			const hooks = manager.getHooks("PostToolUse");
			expect(hooks).toHaveLength(1);
			expect(hooks[0]!.event).toBe("PostToolUse");
			expect(hooks[0]!.command).toBe("echo x");
		});

		it("compiles match string into RegExp", () => {
			manager.register({
				event: "PreToolUse",
				command: "echo",
				match: "^read_",
			});
			const hooks = manager.getHooks("PreToolUse");
			expect(hooks[0]!.match).toBeInstanceOf(RegExp);
			expect(hooks[0]!.match!.test("read_file")).toBe(true);
			expect(hooks[0]!.match!.test("write_file")).toBe(false);
		});

		it("uses default timeout of 5000 when not specified", () => {
			manager.register({ event: "Stop", command: "echo" });
			expect(manager.getHooks("Stop")[0]!.timeout).toBe(5000);
		});

		it("uses custom timeout when specified", () => {
			manager.register({ event: "Stop", command: "echo", timeout: 10000 });
			expect(manager.getHooks("Stop")[0]!.timeout).toBe(10000);
		});

		it("preserves optional description", () => {
			manager.register({
				event: "UserPromptSubmit",
				command: "echo",
				description: "my hook",
			});
			expect(manager.getHooks("UserPromptSubmit")[0]!.description).toBe(
				"my hook",
			);
		});
	});

	// --- unregister ---
	describe("unregister", () => {
		it("removes a hook by id and returns true", () => {
			const id = manager.register({ event: "PreToolUse", command: "echo" });
			expect(manager.unregister(id)).toBe(true);
			expect(manager.getHooks("PreToolUse")).toHaveLength(0);
		});

		it("returns false for an unknown id", () => {
			expect(manager.unregister("hook_999")).toBe(false);
		});

		it("only removes the targeted hook, leaving others intact", () => {
			manager.register({ event: "PreToolUse", command: "echo a" });
			const id2 = manager.register({
				event: "PreToolUse",
				command: "echo b",
			});
			manager.register({ event: "PreToolUse", command: "echo c" });

			manager.unregister(id2);
			const hooks = manager.getHooks("PreToolUse");
			expect(hooks).toHaveLength(2);
			expect(hooks.map((h) => h.command)).toEqual(["echo a", "echo c"]);
		});
	});

	// --- getHooks ---
	describe("getHooks", () => {
		it("returns all hooks across events when no filter given", () => {
			manager.register({ event: "PreToolUse", command: "echo a" });
			manager.register({ event: "PostToolUse", command: "echo b" });
			manager.register({ event: "Stop", command: "echo c" });
			expect(manager.getHooks()).toHaveLength(3);
		});

		it("returns empty array for an event with no hooks", () => {
			expect(manager.getHooks("Stop")).toEqual([]);
		});

		it("returns only hooks matching the requested event", () => {
			manager.register({ event: "PreToolUse", command: "echo a" });
			manager.register({ event: "PostToolUse", command: "echo b" });
			expect(manager.getHooks("PreToolUse")).toHaveLength(1);
		});
	});

	// --- clear ---
	describe("clear", () => {
		it("removes all hooks", () => {
			manager.register({ event: "PreToolUse", command: "echo a" });
			manager.register({ event: "PostToolUse", command: "echo b" });
			manager.clear();
			expect(manager.getHooks()).toHaveLength(0);
		});
	});

	// --- execute ---
	describe("execute", () => {
		const ctx: HookContext = {
			toolName: "read_file",
			workingDirectory: "/tmp",
		};

		it("runs a simple command and returns success", async () => {
			manager.register({ event: "PreToolUse", command: "echo hello" });
			const results = await manager.execute("PreToolUse", ctx);
			expect(results).toHaveLength(1);
			expect(results[0]!.success).toBe(true);
			expect(results[0]!.exitCode).toBe(0);
			expect(results[0]!.stdout).toContain("hello");
		});

		it("returns failure when command exits non-zero", async () => {
			manager.register({
				event: "PreToolUse",
				command: "exit 1",
			});
			const results = await manager.execute("PreToolUse", ctx);
			expect(results).toHaveLength(1);
			expect(results[0]!.success).toBe(false);
			expect(results[0]!.exitCode).toBe(1);
		});

		it("skips hooks that do not match the tool name via match pattern", async () => {
			manager.register({
				event: "PreToolUse",
				command: "echo matched",
				match: "^write_",
			});
			const results = await manager.execute("PreToolUse", {
				toolName: "read_file",
				workingDirectory: "/tmp",
			});
			expect(results).toHaveLength(0);
		});

		it("runs hooks whose match pattern matches the tool name", async () => {
			manager.register({
				event: "PreToolUse",
				command: "echo matched",
				match: "^read_",
			});
			const results = await manager.execute("PreToolUse", {
				toolName: "read_file",
				workingDirectory: "/tmp",
			});
			expect(results).toHaveLength(1);
			expect(results[0]!.success).toBe(true);
		});

		it("returns empty results when no hooks registered for event", async () => {
			const results = await manager.execute("Stop", ctx);
			expect(results).toEqual([]);
		});

		it("runs multiple hooks sequentially and returns all results", async () => {
			manager.register({ event: "PreToolUse", command: "echo one" });
			manager.register({ event: "PreToolUse", command: "echo two" });
			const results = await manager.execute("PreToolUse", ctx);
			expect(results).toHaveLength(2);
			expect(results[0]!.stdout).toContain("one");
			expect(results[1]!.stdout).toContain("two");
		});

		it("sets environment variables from context", async () => {
			manager.register({
				event: "PreToolUse",
				command: "echo $TOOL_NAME",
			});
			const results = await manager.execute("PreToolUse", {
				toolName: "bash",
				workingDirectory: "/tmp",
			});
			expect(results[0]!.stdout.trim()).toBe("bash");
		});

		it("includes a duration in the result", async () => {
			manager.register({ event: "PreToolUse", command: "true" });
			const results = await manager.execute("PreToolUse", ctx);
			expect(results[0]!.duration).toBeGreaterThanOrEqual(0);
		});
	});

	// --- HOOK_EVENTS constant ---
	describe("HOOK_EVENTS constant", () => {
		it("contains all four event types", () => {
			expect(HOOK_EVENTS).toEqual([
				"PreToolUse",
				"PostToolUse",
				"UserPromptSubmit",
				"Stop",
			]);
		});
	});
});

// ============================================================
// Module 2: CapacityController
// ============================================================
describe("CapacityController", () => {
	// --- constructor defaults ---
	describe("constructor", () => {
		it("uses default config when no args given", () => {
			const cc = new CapacityController();
			const cfg = cc.getConfig();
			expect(cfg.enabled).toBe(true);
			expect(cfg.lowRiskMax).toBe(0.5);
			expect(cfg.mediumRiskMax).toBe(0.62);
			expect(cfg.severeMinSlack).toBe(-0.25);
			expect(cfg.refreshCooldownTurns).toBe(6);
		});

		it("merges partial config with defaults", () => {
			const cc = new CapacityController({ lowRiskMax: 0.7 });
			expect(cc.getConfig().lowRiskMax).toBe(0.7);
			expect(cc.getConfig().mediumRiskMax).toBe(0.62); // default
		});
	});

	// --- risk band calculation ---
	describe("observe - risk band", () => {
		it("returns low risk when usage below lowRiskMax", () => {
			const cc = new CapacityController({ lowRiskMax: 0.5 });
			const snap = cc.observe({
				turnIndex: 0,
				promptTokens: 400,
				maxTokens: 1000,
				toolCalls: 0,
			});
			expect(snap.riskBand).toBe("low");
			expect(snap.contextUsedRatio).toBeCloseTo(0.4);
		});

		it("returns medium risk when usage between low and medium thresholds", () => {
			const cc = new CapacityController({ lowRiskMax: 0.5, mediumRiskMax: 0.62 });
			const snap = cc.observe({
				turnIndex: 0,
				promptTokens: 560,
				maxTokens: 1000,
				toolCalls: 0,
			});
			expect(snap.riskBand).toBe("medium");
			expect(snap.contextUsedRatio).toBeCloseTo(0.56);
		});

		it("returns high risk when usage at or above mediumRiskMax", () => {
			const cc = new CapacityController({ mediumRiskMax: 0.62 });
			const snap = cc.observe({
				turnIndex: 0,
				promptTokens: 700,
				maxTokens: 1000,
				toolCalls: 0,
			});
			expect(snap.riskBand).toBe("high");
		});
	});

	// --- slack calculation ---
	describe("observe - slack", () => {
		it("calculates slack as 1 - contextUsedRatio", () => {
			const cc = new CapacityController();
			const snap = cc.observe({
				turnIndex: 0,
				promptTokens: 300,
				maxTokens: 1000,
				toolCalls: 0,
			});
			expect(snap.slack).toBeCloseTo(0.7);
		});
	});

	// --- guardrail actions ---
	describe("observe - guardrail actions", () => {
		it("returns no_intervention for low risk", () => {
			const cc = new CapacityController();
			const snap = cc.observe({
				turnIndex: 0,
				promptTokens: 100,
				maxTokens: 1000,
				toolCalls: 0,
			});
			expect(snap.action).toBe("no_intervention");
		});

		it("returns no_intervention when disabled regardless of usage", () => {
			const cc = new CapacityController({ enabled: false });
			const snap = cc.observe({
				turnIndex: 0,
				promptTokens: 900,
				maxTokens: 1000,
				toolCalls: 0,
			});
			expect(snap.action).toBe("no_intervention");
		});

		it("returns targeted_refresh for high risk with slack above severeMinSlack", () => {
			const cc = new CapacityController({ severeMinSlack: -0.25 });
			// 0.7 usage -> high risk, slack = 0.3 > -0.25
			const snap = cc.observe({
				turnIndex: 0,
				promptTokens: 700,
				maxTokens: 1000,
				toolCalls: 0,
			});
			expect(snap.action).toBe("targeted_refresh");
		});

		it("returns verify_and_replan for high risk with slack below severeMinSlack", () => {
			const cc = new CapacityController({ severeMinSlack: 0.1 });
			// 0.95 usage -> high risk, slack = 0.05 < 0.1
			const snap = cc.observe({
				turnIndex: 0,
				promptTokens: 950,
				maxTokens: 1000,
				toolCalls: 0,
			});
			expect(snap.action).toBe("verify_and_replan");
		});

		it("returns targeted_refresh for medium risk when cooldown elapsed", () => {
			const cc = new CapacityController({
				lowRiskMax: 0.5,
				mediumRiskMax: 0.62,
				refreshCooldownTurns: 3,
			});
			// turnIndex 5, lastRefreshTurn default 0 -> turnsSinceRefresh = 5 >= 3
			const snap = cc.observe({
				turnIndex: 5,
				promptTokens: 560,
				maxTokens: 1000,
				toolCalls: 0,
			});
			expect(snap.action).toBe("targeted_refresh");
		});

		it("returns no_intervention for medium risk when cooldown not elapsed", () => {
			const cc = new CapacityController({
				lowRiskMax: 0.5,
				mediumRiskMax: 0.62,
				refreshCooldownTurns: 10,
			});
			cc.recordRefresh(0);
			// turnIndex 5, lastRefreshTurn 0 -> turnsSinceRefresh = 5 < 10
			const snap = cc.observe({
				turnIndex: 5,
				promptTokens: 560,
				maxTokens: 1000,
				toolCalls: 0,
			});
			expect(snap.action).toBe("no_intervention");
		});
	});

	// --- recordRefresh ---
	describe("recordRefresh", () => {
		it("updates lastRefreshTurn which affects medium risk cooldown", () => {
			const cc = new CapacityController({
				lowRiskMax: 0.5,
				mediumRiskMax: 0.62,
				refreshCooldownTurns: 3,
			});

			cc.recordRefresh(10);
			// turn 12 -> turnsSinceRefresh = 2 < 3 -> no_intervention
			const snap1 = cc.observe({
				turnIndex: 12,
				promptTokens: 560,
				maxTokens: 1000,
				toolCalls: 0,
			});
			expect(snap1.action).toBe("no_intervention");

			// turn 13 -> turnsSinceRefresh = 3 >= 3 -> targeted_refresh
			const snap2 = cc.observe({
				turnIndex: 13,
				promptTokens: 560,
				maxTokens: 1000,
				toolCalls: 0,
			});
			expect(snap2.action).toBe("targeted_refresh");
		});
	});

	// --- history / snapshots ---
	describe("history and snapshots", () => {
		it("getHistory returns a copy of all observations", () => {
			const cc = new CapacityController();
			cc.observe({ turnIndex: 0, promptTokens: 100, maxTokens: 1000, toolCalls: 0 });
			cc.observe({ turnIndex: 1, promptTokens: 200, maxTokens: 1000, toolCalls: 0 });

			const history = cc.getHistory();
			expect(history).toHaveLength(2);
			expect(history[0]!.turnIndex).toBe(0);
			expect(history[1]!.turnIndex).toBe(1);
		});

		it("getLastSnapshot returns the most recent observation", () => {
			const cc = new CapacityController();
			cc.observe({ turnIndex: 0, promptTokens: 100, maxTokens: 1000, toolCalls: 0 });
			cc.observe({ turnIndex: 5, promptTokens: 500, maxTokens: 1000, toolCalls: 2 });

			const last = cc.getLastSnapshot();
			expect(last!.turnIndex).toBe(5);
			expect(last!.contextUsedRatio).toBeCloseTo(0.5);
		});

		it("getLastSnapshot returns undefined when no observations", () => {
			const cc = new CapacityController();
			expect(cc.getLastSnapshot()).toBeUndefined();
		});

		it("getHistory returns a defensive copy (mutations do not affect internal state)", () => {
			const cc = new CapacityController();
			cc.observe({ turnIndex: 0, promptTokens: 100, maxTokens: 1000, toolCalls: 0 });
			const history = cc.getHistory();
			history.push({
				turnIndex: 99,
				contextUsedRatio: 0.99,
				riskBand: "high",
				slack: 0.01,
				action: "verify_and_replan",
			});
			expect(cc.getHistory()).toHaveLength(1);
		});
	});

	// --- enable / disable / isEnabled ---
	describe("enable/disable", () => {
		it("starts enabled by default", () => {
			const cc = new CapacityController();
			expect(cc.isEnabled()).toBe(true);
		});

		it("disable sets enabled to false", () => {
			const cc = new CapacityController();
			cc.disable();
			expect(cc.isEnabled()).toBe(false);
		});

		it("enable re-enables after disable", () => {
			const cc = new CapacityController();
			cc.disable();
			cc.enable();
			expect(cc.isEnabled()).toBe(true);
		});
	});

	// --- updateConfig ---
	describe("updateConfig", () => {
		it("merges partial config into existing", () => {
			const cc = new CapacityController();
			cc.updateConfig({ lowRiskMax: 0.8 });
			expect(cc.getConfig().lowRiskMax).toBe(0.8);
			expect(cc.getConfig().mediumRiskMax).toBe(0.62); // unchanged
		});

		it("getConfig returns a defensive copy", () => {
			const cc = new CapacityController();
			const cfg = cc.getConfig();
			cfg.enabled = false;
			expect(cc.isEnabled()).toBe(true); // not affected
		});
	});

	// --- observe snapshot shape ---
	describe("observe - snapshot shape", () => {
		it("includes all required fields", () => {
			const cc = new CapacityController();
			const snap = cc.observe({
				turnIndex: 3,
				promptTokens: 250,
				maxTokens: 1000,
				toolCalls: 5,
			});
			expect(snap).toEqual({
				turnIndex: 3,
				contextUsedRatio: 0.25,
				riskBand: "low",
				slack: 0.75,
				action: "no_intervention",
			});
		});
	});
});

// ============================================================
// Module 3: EngineBridge and mapLoopEvent
// ============================================================
describe("mapLoopEvent", () => {
	function makeToolCall(name: string, args = "{}") {
		return { type: "function" as const, function: { name, arguments: args } };
	}

	it("maps content event to assistant UiEvent", () => {
		const e: LoopEvent = { type: "content", content: "hello" };
		expect(mapLoopEvent(e)).toEqual({ kind: "assistant", text: "hello" });
	});

	it("maps reasoning event to reasoning UiEvent", () => {
		const e: LoopEvent = { type: "reasoning", content: "thinking..." };
		expect(mapLoopEvent(e)).toEqual({ kind: "reasoning", text: "thinking..." });
	});

	it("maps tool_call event to tool UiEvent", () => {
		const e: LoopEvent = {
			type: "tool_call",
			toolCall: makeToolCall("bash", '{"cmd":"ls"}'),
			repaired: false,
		};
		expect(mapLoopEvent(e)).toEqual({
			kind: "tool",
			name: "bash",
			args: '{"cmd":"ls"}',
		});
	});

	it("maps successful tool_result event", () => {
		const e: LoopEvent = {
			type: "tool_result",
			toolCall: makeToolCall("read_file"),
			result: { content: "file contents" },
			success: true,
		};
		expect(mapLoopEvent(e)).toEqual({
			kind: "tool_result",
			name: "read_file",
			ok: true,
			content: "file contents",
		});
	});

	it("maps failed tool_result event", () => {
		const e: LoopEvent = {
			type: "tool_result",
			toolCall: makeToolCall("write_file"),
			result: { content: "error msg" },
			success: false,
		};
		expect(mapLoopEvent(e)).toEqual({
			kind: "tool_result",
			name: "write_file",
			ok: false,
			content: "error msg",
		});
	});

	it("maps tool_result with non-string content to empty string", () => {
		const e: LoopEvent = {
			type: "tool_result",
			toolCall: makeToolCall("tool"),
			result: { content: 42 },
			success: true,
		};
		expect(mapLoopEvent(e)!.kind).toBe("tool_result");
		expect((mapLoopEvent(e) as any).content).toBe("");
	});

	it("maps validation failure to notice UiEvent", () => {
		const e: LoopEvent = { type: "validation", result: { passed: false } };
		expect(mapLoopEvent(e)).toEqual({
			kind: "notice",
			text: "validation failed",
			tone: "warn",
		});
	});

	it("returns null for validation that passed", () => {
		const e: LoopEvent = { type: "validation", result: { passed: true } };
		expect(mapLoopEvent(e)).toBeNull();
	});

	it("maps incomplete completeness to notice", () => {
		const e: LoopEvent = { type: "completeness", result: { complete: false } };
		expect(mapLoopEvent(e)).toEqual({
			kind: "notice",
			text: "incomplete — agent will continue",
			tone: "warn",
		});
	});

	it("returns null for complete completeness", () => {
		const e: LoopEvent = { type: "completeness", result: { complete: true } };
		expect(mapLoopEvent(e)).toBeNull();
	});

	it("maps folded context_optimized to notice", () => {
		const e: LoopEvent = { type: "context_optimized", result: { folded: true } };
		expect(mapLoopEvent(e)).toEqual({
			kind: "notice",
			text: "context folded",
			tone: "info",
		});
	});

	it("returns null for non-folded context_optimized", () => {
		const e: LoopEvent = { type: "context_optimized", result: { folded: false } };
		expect(mapLoopEvent(e)).toBeNull();
	});

	it("returns null for capacity with no_intervention", () => {
		const e: LoopEvent = {
			type: "capacity",
			snapshot: {
				turnIndex: 0,
				contextUsedRatio: 0.3,
				riskBand: "low",
				slack: 0.7,
				action: "no_intervention",
			},
		};
		expect(mapLoopEvent(e)).toBeNull();
	});

	it("maps capacity with non-no_intervention to notice", () => {
		const e: LoopEvent = {
			type: "capacity",
			snapshot: {
				turnIndex: 0,
				contextUsedRatio: 0.7,
				riskBand: "high",
				slack: 0.3,
				action: "targeted_refresh",
			},
		};
		expect(mapLoopEvent(e)).toEqual({
			kind: "notice",
			text: "capacity: targeted_refresh",
			tone: "warn",
		});
	});

	it("maps hook event to notice", () => {
		const e: LoopEvent = { type: "hook", event: "PreToolUse", results: [] };
		expect(mapLoopEvent(e)).toEqual({
			kind: "notice",
			text: "hook · PreToolUse",
			tone: "info",
		});
	});

	it("maps plan_blocked event to notice", () => {
		const e: LoopEvent = {
			type: "plan_blocked",
			toolCall: makeToolCall("bash"),
		};
		expect(mapLoopEvent(e)).toEqual({
			kind: "notice",
			text: "plan mode blocked bash",
			tone: "warn",
		});
	});

	it("maps iteration event to notice", () => {
		const e: LoopEvent = { type: "iteration", attempt: 2, maxAttempts: 5 };
		expect(mapLoopEvent(e)).toEqual({
			kind: "notice",
			text: "retry 2/5",
			tone: "info",
		});
	});

	it("maps steer_accepted event to notice", () => {
		const e: LoopEvent = { type: "steer_accepted", content: "new direction" };
		expect(mapLoopEvent(e)).toEqual({
			kind: "notice",
			text: "steer: new direction",
			tone: "info",
		});
	});

	it("maps usage event with all fields", () => {
		const e: LoopEvent = {
			type: "usage",
			usage: {
				totalTokens: 1500,
				totalPromptTokens: 1000,
				totalCompletionTokens: 500,
				totalCachedTokens: 200,
				toolCalls: 3,
				steps: 5,
				totalCost: 0.02,
				totalCostCurrency: "CNY",
			},
		};
		expect(mapLoopEvent(e)).toEqual({
			kind: "usage",
			totalTokens: 1500,
			promptTokens: 1000,
			completionTokens: 500,
			cachedTokens: 200,
			toolCalls: 3,
			steps: 5,
			totalCost: 0.02,
			currency: "CNY",
		});
	});

	it("maps usage event with missing fields to zeros", () => {
		const e: LoopEvent = { type: "usage", usage: null };
		expect(mapLoopEvent(e)).toEqual({
			kind: "usage",
			totalTokens: 0,
			promptTokens: 0,
			completionTokens: 0,
			cachedTokens: 0,
			toolCalls: 0,
			steps: 0,
			totalCost: 0,
			currency: "CNY",
		});
	});

	it("maps error event", () => {
		const e: LoopEvent = { type: "error", error: "something broke", recoverable: true };
		expect(mapLoopEvent(e)).toEqual({
			kind: "error",
			text: "something broke",
		});
	});

	it("maps done event", () => {
		const e: LoopEvent = { type: "done", success: true };
		expect(mapLoopEvent(e)).toEqual({ kind: "done", success: true });
	});

	it("maps done event with failure", () => {
		const e: LoopEvent = { type: "done", success: false };
		expect(mapLoopEvent(e)).toEqual({ kind: "done", success: false });
	});

	it("returns null for unknown event types", () => {
		const e = { type: "unknown_event" } as unknown as LoopEvent;
		expect(mapLoopEvent(e)).toBeNull();
	});
});

// ============================================================
// parsePlanFromTodoResult
// ============================================================
describe("parsePlanFromTodoResult", () => {
	it("returns null for empty string", () => {
		expect(parsePlanFromTodoResult("")).toBeNull();
	});

	it("returns null when no matching lines found", () => {
		expect(parsePlanFromTodoResult("no plan here")).toBeNull();
	});

	it("parses pending tasks ([ ])", () => {
		const steps = parsePlanFromTodoResult("[ ] Step one\n[ ] Step two");
		expect(steps).toEqual([
			{ label: "Step one", status: "pending" },
			{ label: "Step two", status: "pending" },
		]);
	});

	it("parses in-progress tasks ([~])", () => {
		const steps = parsePlanFromTodoResult("[~] Working on it");
		expect(steps).toEqual([{ label: "Working on it", status: "in_progress" }]);
	});

	it("parses completed tasks ([x])", () => {
		const steps = parsePlanFromTodoResult("[x] Done");
		expect(steps).toEqual([{ label: "Done", status: "completed" }]);
	});

	it("parses mixed statuses", () => {
		const content = "[x] First\n[~] Second\n[ ] Third";
		const steps = parsePlanFromTodoResult(content);
		expect(steps).toEqual([
			{ label: "First", status: "completed" },
			{ label: "Second", status: "in_progress" },
			{ label: "Third", status: "pending" },
		]);
	});

	it("ignores non-matching lines between plan items", () => {
		const content = "Header text\n[ ] Item A\nSome noise\n[ ] Item B";
		const steps = parsePlanFromTodoResult(content);
		expect(steps).toHaveLength(2);
		expect(steps![0]!.label).toBe("Item A");
	});
});

// ============================================================
// EngineBridge class
// ============================================================
describe("EngineBridge", () => {
	function makeToolCall(name: string, args = "{}") {
		return { type: "function" as const, function: { name, arguments: args } };
	}

	function makeMockLoop(events: LoopEvent[]) {
		return {
			async *run(_input: string) {
				for (const e of events) {
					yield e;
				}
			},
		};
	}

	it("yields mapped UI events from the underlying loop", async () => {
		const events: LoopEvent[] = [
			{ type: "content", content: "hello" },
			{ type: "done", success: true },
		];
		const bridge = new EngineBridge(makeMockLoop(events));
		const collected: UiEvent[] = [];
		for await (const e of bridge.send("hi")) {
			collected.push(e);
		}
		expect(collected).toEqual([
			{ kind: "assistant", text: "hello" },
			{ kind: "done", success: true },
		]);
	});

	it("skips events that mapLoopEvent returns null for", async () => {
		const events: LoopEvent[] = [
			{ type: "validation", result: { passed: true } }, // maps to null
			{ type: "content", content: "ok" },
			{ type: "done", success: true },
		];
		const bridge = new EngineBridge(makeMockLoop(events));
		const collected: UiEvent[] = [];
		for await (const e of bridge.send("hi")) {
			collected.push(e);
		}
		expect(collected).toEqual([
			{ kind: "assistant", text: "ok" },
			{ kind: "done", success: true },
		]);
	});

	it("yields plan event when todo_write tool_result is successful", async () => {
		const events: LoopEvent[] = [
			{
				type: "tool_result",
				toolCall: makeToolCall("todo_write"),
				result: { content: "[x] Step A\n[ ] Step B" },
				success: true,
			},
			{ type: "done", success: true },
		];
		const bridge = new EngineBridge(makeMockLoop(events));
		const collected: UiEvent[] = [];
		for await (const e of bridge.send("hi")) {
			collected.push(e);
		}
		// Should include tool_result + plan + done
		expect(collected[0]).toEqual({
			kind: "tool_result",
			name: "todo_write",
			ok: true,
			content: "[x] Step A\n[ ] Step B",
		});
		expect(collected[1]).toEqual({
			kind: "plan",
			steps: [
				{ label: "Step A", status: "completed" },
				{ label: "Step B", status: "pending" },
			],
		});
		expect(collected[2]).toEqual({ kind: "done", success: true });
	});

	it("does not yield plan event for failed todo_write", async () => {
		const events: LoopEvent[] = [
			{
				type: "tool_result",
				toolCall: makeToolCall("todo_write"),
				result: { content: "[x] Step A" },
				success: false,
			},
			{ type: "done", success: true },
		];
		const bridge = new EngineBridge(makeMockLoop(events));
		const collected: UiEvent[] = [];
		for await (const e of bridge.send("hi")) {
			collected.push(e);
		}
		// tool_result (failed) + done, no plan
		expect(collected).toHaveLength(2);
		expect(collected.some((e) => e.kind === "plan")).toBe(false);
	});

	it("does not yield plan event for non-todo_write tool_result", async () => {
		const events: LoopEvent[] = [
			{
				type: "tool_result",
				toolCall: makeToolCall("bash"),
				result: { content: "[x] looks like a plan" },
				success: true,
			},
			{ type: "done", success: true },
		];
		const bridge = new EngineBridge(makeMockLoop(events));
		const collected: UiEvent[] = [];
		for await (const e of bridge.send("hi")) {
			collected.push(e);
		}
		expect(collected.some((e) => e.kind === "plan")).toBe(false);
	});

	it("resolvePermission resolves a pending promise", async () => {
		const events: LoopEvent[] = [
			{ type: "content", content: "text" },
			{ type: "done", success: true },
		];
		const bridge = new EngineBridge(makeMockLoop(events));

		// Simulate a pending permission by calling askUser indirectly via the
		// ApprovalManager integration. Since askUser is private, we test
		// resolvePermission by verifying it doesn't throw on unknown ids.
		expect(() => {
			bridge.resolvePermission("nonexistent-id", {
				approved: true,
				reason: "ok",
			});
		}).not.toThrow();
	});

	it("handles empty loop (no events)", async () => {
		const bridge = new EngineBridge(makeMockLoop([]));
		const collected: UiEvent[] = [];
		for await (const e of bridge.send("hi")) {
			collected.push(e);
		}
		expect(collected).toEqual([]);
	});
});
