import { describe, expect, it } from "vitest";
import { createMiMoStack } from "../../src/config/createMiMoStack.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";
import { ExecShellTool } from "../../src/tools/shell/ExecShellTool.js";
import { parseRateLimitedToolResult } from "../../src/tools/limits/ToolRateLimiter.js";

describe("Wave 2a 端到端:rateLimit 配置 → ToolRegistry 短路", () => {
	it("aggregate maxCalls=1 时第二次调用返回 rate_limited", async () => {
		const registry = new ToolRegistry();
		registry.register(new ExecShellTool());
		const stub = { streamChat: async function*() {} };
		const stack = createMiMoStack(stub, registry, process.cwd(), {
			rateLimit: { aggregate: { maxCalls: 1, windowSeconds: 60 } },
		});
		expect(stack.rateLimiter).toBeDefined();

		// 第一次成功
		const first = await registry.execute({
			function: {
				name: "exec_shell",
				arguments: '{"command":"node -e \\"console.log(\\\\\\"a\\\\\\")\\""}',
			},
		});
		expect(first.isError).toBeFalsy();

		// 第二次被限流
		const second = await registry.execute({
			function: {
				name: "exec_shell",
				arguments: '{"command":"node -e \\"console.log(\\\\\\"b\\\\\\")\\""}',
			},
		});
		expect(second.isError).toBe(true);
		const parsed = parseRateLimitedToolResult(second.content);
		expect(parsed).not.toBeNull();
		expect(parsed?.error).toBe("rate_limited");
		expect(parsed?.scope).toBe("all_tools");
	});

	it("rateLimit:false 时不施加限流", async () => {
		const registry = new ToolRegistry();
		registry.register(new ExecShellTool());
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, registry, process.cwd(), { rateLimit: false });
		for (let i = 0; i < 5; i++) {
			const r = await registry.execute({
				function: {
					name: "exec_shell",
					arguments: '{"command":"node -e \\"console.log(\\\\\\"x\\\\\\")\\""}',
				},
			});
			expect(r.isError).toBeFalsy();
		}
	});
});
