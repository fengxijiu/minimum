import { describe, expect, it } from "vitest";
import { createMiMoStack } from "../../src/config/createMiMoStack.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";

describe("Wave 2b 端到端 — shell + jobs 注册到工厂", () => {
	it("createMiMoStack 注册全部 6 个 shell 工具", () => {
		const reg = new ToolRegistry();
		const stub = { streamChat: async function* () {} };
		createMiMoStack(stub, reg, process.cwd(), {});
		expect(reg.has("exec_shell")).toBe(true);
		expect(reg.has("run_background")).toBe(true);
		expect(reg.has("job_output")).toBe(true);
		expect(reg.has("wait_for_job")).toBe(true);
		expect(reg.has("stop_job")).toBe(true);
		expect(reg.has("list_jobs")).toBe(true);
	});

	it("MiMoStack 暴露共享 JobRegistry", () => {
		const reg = new ToolRegistry();
		const stub = { streamChat: async function* () {} };
		const stack = createMiMoStack(stub, reg, process.cwd(), {});
		expect(stack.jobs).toBeDefined();
		expect(typeof stack.jobs.start).toBe("function");
	});

	it("exec_shell 通过 registry 执行 allowlisted 命令", async () => {
		const reg = new ToolRegistry();
		const stub = { streamChat: async function* () {} };
		createMiMoStack(stub, reg, process.cwd(), {});
		const res = await reg.execute({
			function: {
				name: "exec_shell",
				arguments: JSON.stringify({ command: "node --version" }),
			},
		});
		expect(res.content).toMatch(/v\d+/);
		expect(res.isError).toBeFalsy();
	}, 10000);

	it("list_jobs 通过 registry — 空列表提示", async () => {
		const reg = new ToolRegistry();
		const stub = { streamChat: async function* () {} };
		createMiMoStack(stub, reg, process.cwd(), {});
		const res = await reg.execute({
			function: {
				name: "list_jobs",
				arguments: "{}",
			},
		});
		expect(res.content).toMatch(/no background jobs/i);
	});
});
