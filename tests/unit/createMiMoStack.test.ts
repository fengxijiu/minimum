import { describe, expect, it } from "vitest";
import { createMiMoStack } from "../../src/config/createMiMoStack.js";
import { ToolRateLimiter } from "../../src/tools/limits/ToolRateLimiter.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";
import { ChoiceTool } from "../../src/tools/choice/ChoiceTool.js";
import { DeferredConfirmationGate } from "../../src/tools/choice/ConfirmationGate.js";

describe("createMiMoStack — ToolRateLimiter 集成", () => {
	it("cfg.rateLimit 提供时,工厂构造 ToolRateLimiter 并把它附加到 stack", () => {
		const registry = new ToolRegistry();
		const stub = { streamChat: async function*() {} };
		const stack = createMiMoStack(
			stub,
			registry,
			"/tmp/work",
			{ rateLimit: { aggregate: { maxCalls: 5, windowSeconds: 60 } } },
		);
		expect(stack.rateLimiter).toBeInstanceOf(ToolRateLimiter);
		const policy = stack.rateLimiter?.policy;
		expect(policy).not.toBe(false);
		if (policy && policy !== false) {
			expect(policy.aggregate.maxCalls).toBe(5);
		}
	});

	it("cfg.rateLimit:false 时不构造限流器", () => {
		const registry = new ToolRegistry();
		const stub = { streamChat: async function*() {} };
		const stack = createMiMoStack(
			stub,
			registry,
			"/tmp/work",
			{ rateLimit: false },
		);
		expect(stack.rateLimiter).toBeUndefined();
	});

	it("deps.toolRateLimiter 注入时优先于 cfg.rateLimit", () => {
		const registry = new ToolRegistry();
		const injected = new ToolRateLimiter({ aggregate: { maxCalls: 999, windowSeconds: 60 } });
		const stub = { streamChat: async function*() {} };
		const stack = createMiMoStack(
			stub,
			registry,
			"/tmp/work",
			{ rateLimit: { aggregate: { maxCalls: 5, windowSeconds: 60 } } },
			{ toolRateLimiter: injected },
		);
		expect(stack.rateLimiter).toBe(injected);
	});
});

describe("createMiMoStack - code query builtins", () => {
	it("registers get_symbols and find_in_code", () => {
		const registry = new ToolRegistry();
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, registry, "/tmp/work", {});
		expect(registry.has("get_symbols")).toBe(true);
		expect(registry.has("find_in_code")).toBe(true);
	});
});

describe("createMiMoStack — ChoiceTool 内置注册", () => {
	it("ChoiceTool 被注册到 tools registry", () => {
		const registry = new ToolRegistry();
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, registry, "/tmp/work", {});
		expect(registry.has("ask_choice")).toBe(true);
	});

	it("不重复注册:当 registry 已有 ask_choice 时跳过", () => {
		const registry = new ToolRegistry();
		const preExisting = new ChoiceTool();
		registry.register(preExisting as any);
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, registry, "/tmp/work", {});
		expect(registry.get("ask_choice")).toBeTruthy();
		// Still has exactly one ask_choice registration
		expect(registry.getAll().filter(t => t.name === "ask_choice").length).toBe(1);
	});

	it("deps.confirmationGate 透传到 ChoiceTool", async () => {
		const registry = new ToolRegistry();
		const gate = new DeferredConfirmationGate();
		gate.resolve({ type: "pick", optionId: "X" });
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, registry, "/tmp/work", {}, { confirmationGate: gate });
		const res = await registry.execute({
			function: {
				name: "ask_choice",
				arguments: JSON.stringify({
					question: "P?",
					options: [
						{ id: "X", title: "X" },
						{ id: "Y", title: "Y" },
					],
				}),
			},
		});
		expect(res.content).toBe("user picked: X");
	});
});
