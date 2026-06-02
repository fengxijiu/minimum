import { describe, expect, it } from "vitest";
import { TodoWriteTool } from "../../src/tools/todo/TodoWriteTool.js";

describe("TodoWriteTool (enhanced)", () => {
	it("缺 activeForm 返回错误", async () => {
		const tool = new TodoWriteTool();
		const out = await tool.execute({
			todos: [{ content: "x", status: "pending" }],
		});
		expect(out).toMatch(/activeForm/);
	});

	it("两个 in_progress 返回错误", async () => {
		const tool = new TodoWriteTool();
		const out = await tool.execute({
			todos: [
				{ content: "a", status: "in_progress", activeForm: "Doing a" },
				{ content: "b", status: "in_progress", activeForm: "Doing b" },
			],
		});
		expect(out).toMatch(/in_progress/);
	});

	it("空数组清空", async () => {
		const tool = new TodoWriteTool();
		await tool.execute({
			todos: [{ content: "a", status: "pending", activeForm: "Doing a" }],
		});
		const out = await tool.execute({ todos: [] });
		expect(out).toMatch(/cleared/i);
		expect(tool.getTodos()).toEqual([]);
	});

	it("in_progress 渲染 activeForm,其它渲染 content", async () => {
		const tool = new TodoWriteTool();
		const out = await tool.execute({
			todos: [
				{ content: "Write tests", status: "completed", activeForm: "Writing tests" },
				{ content: "Run lint", status: "in_progress", activeForm: "Running lint" },
				{ content: "Commit", status: "pending", activeForm: "Committing" },
			],
		});
		expect(out).toContain("[x] Write tests");
		expect(out).toContain("[>] Running lint");
		expect(out).toContain("[ ] Commit");
	});

	it("非法 status 返回错误", async () => {
		const tool = new TodoWriteTool();
		const out = await tool.execute({
			todos: [{ content: "x", status: "wat", activeForm: "Doing x" }],
		});
		expect(out).toMatch(/status/);
	});
});
