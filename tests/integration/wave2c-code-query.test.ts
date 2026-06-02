import { describe, expect, it } from "vitest";
import { createMiMoStack } from "../../src/config/createMiMoStack.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";

describe("Wave 2c 端到端 — code-query 工具注册到工厂", () => {
	it("get_symbols + find_in_code 都被注册", () => {
		const reg = new ToolRegistry();
		const stub = { streamChat: async function* () {} };
		createMiMoStack(stub, reg, process.cwd(), {});
		expect(reg.has("get_symbols")).toBe(true);
		expect(reg.has("find_in_code")).toBe(true);
	});

	it("通过 registry 调 get_symbols 拿到 sample.ts 的符号", async () => {
		const reg = new ToolRegistry();
		const stub = { streamChat: async function* () {} };
		createMiMoStack(stub, reg, process.cwd(), {});
		const res = await reg.execute({
			function: {
				name: "get_symbols",
				arguments: JSON.stringify({ path: "tests/fixtures/sample.ts" }),
			},
		});
		const parsed = JSON.parse(res.content);
		expect(parsed.symbols.length).toBeGreaterThan(0);
	}, 15000);

	it("find_in_code 通过 registry 工作", async () => {
		const reg = new ToolRegistry();
		const stub = { streamChat: async function* () {} };
		createMiMoStack(stub, reg, process.cwd(), {});
		const res = await reg.execute({
			function: {
				name: "find_in_code",
				arguments: JSON.stringify({
					name: "topLevel",
					path: "tests/fixtures/sample.ts",
				}),
			},
		});
		const parsed = JSON.parse(res.content);
		expect(parsed.matches.length).toBeGreaterThan(0);
	}, 15000);
});
