import { describe, expect, it } from "vitest";
import { ChoiceTool } from "../../src/tools/choice/ChoiceTool.js";
import {
	CancelledConfirmationGate,
	DeferredConfirmationGate,
} from "../../src/tools/choice/ConfirmationGate.js";

describe("ChoiceTool", () => {
	it("question 为空返回错误", async () => {
		const tool = new ChoiceTool({ gate: new CancelledConfirmationGate() });
		const out = await tool.execute({
			question: "",
			options: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
		});
		expect(out).toMatch(/question is required/);
	});

	it("options 少于 2 个返回错误", async () => {
		const tool = new ChoiceTool({ gate: new CancelledConfirmationGate() });
		const out = await tool.execute({
			question: "Pick one",
			options: [{ id: "a", title: "A" }],
		});
		expect(out).toMatch(/at least 2/i);
	});

	it("options 多于 6 个返回错误", async () => {
		const tool = new ChoiceTool({ gate: new CancelledConfirmationGate() });
		const out = await tool.execute({
			question: "Pick one",
			options: Array.from({ length: 7 }, (_, i) => ({
				id: `o${i}`,
				title: `O${i}`,
			})),
		});
		expect(out).toMatch(/too many/i);
	});

	it("重复 id 去重", async () => {
		const gate = new DeferredConfirmationGate();
		gate.resolve({ type: "pick", optionId: "a" });
		const tool = new ChoiceTool({ gate });
		const out = await tool.execute({
			question: "Pick",
			options: [
				{ id: "a", title: "A" },
				{ id: "a", title: "A again" },
				{ id: "b", title: "B" },
			],
		});
		expect(out).toBe("user picked: a");
	});

	it("默认 gate 返回 cancelled", async () => {
		const tool = new ChoiceTool({ gate: new CancelledConfirmationGate() });
		const out = await tool.execute({
			question: "Pick",
			options: [
				{ id: "a", title: "A" },
				{ id: "b", title: "B" },
			],
		});
		expect(out).toBe("user cancelled the choice");
	});

	it("pick verdict → user picked: X", async () => {
		const gate = new DeferredConfirmationGate();
		const tool = new ChoiceTool({ gate });
		const p = tool.execute({
			question: "Pick",
			options: [
				{ id: "a", title: "A" },
				{ id: "b", title: "B" },
			],
		});
		gate.resolve({ type: "pick", optionId: "b" });
		expect(await p).toBe("user picked: b");
	});

	it("text verdict → user answered: ...", async () => {
		const gate = new DeferredConfirmationGate();
		const tool = new ChoiceTool({ gate });
		const p = tool.execute({
			question: "Pick",
			options: [
				{ id: "a", title: "A" },
				{ id: "b", title: "B" },
			],
			allowCustom: true,
		});
		gate.resolve({ type: "text", text: "neither — explain more" });
		expect(await p).toBe("user answered: neither — explain more");
	});
});
