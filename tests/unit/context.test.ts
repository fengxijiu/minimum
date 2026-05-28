import { beforeEach, describe, expect, it } from "vitest";
import { ContextManager } from "../../src/context/ContextManager.js";

describe("Context", () => {
	describe("ContextManager", () => {
		let manager: ContextManager;

		beforeEach(() => {
			manager = new ContextManager();
		});

		it("should count tokens", () => {
			const messages = [
				{ role: "user", content: "Hello world" },
				{ role: "assistant", content: "Hi there!" },
			];

			const count = manager.countTokens(messages);
			expect(count).toBeGreaterThan(0);
		});

		it("should determine if folding needed", () => {
			// foldThreshold 默认是 0.7，所以 5600/8000 = 0.7 应该返回 true
			expect(manager.shouldFold(5600, 8000)).toBe(true);
			expect(manager.shouldFold(3000, 8000)).toBe(false);
		});

		it("should optimize context when under threshold", async () => {
			const result = await manager.optimize({
				messages: Array.from({ length: 10 }, (_, i) => ({
					role: i % 2 === 0 ? "user" : "assistant",
					content: `Message ${i}`,
				})),
				taskState: {
					objective: "test",
					currentStep: 1,
					completedSubtasks: [],
					pendingSubtasks: [],
				},
				maxTokens: 100000,
			});

			expect(result).toBeDefined();
			expect(result.messages).toBeDefined();
			expect(result.folded).toBe(false);
		});

		it("should optimize context when over threshold", async () => {
			const result = await manager.optimize({
				messages: Array.from({ length: 100 }, (_, i) => ({
					role: i % 2 === 0 ? "user" : "assistant",
					content: `Message ${i} `.repeat(100),
				})),
				taskState: {
					objective: "test",
					currentStep: 1,
					completedSubtasks: [],
					pendingSubtasks: [],
				},
				maxTokens: 1000,
			});

			expect(result).toBeDefined();
			expect(result.messages).toBeDefined();
			expect(result.tokens).toBeDefined();
		});

		it("should extract key info", async () => {
			const messages = [
				{ role: "user", content: "实现一个加法函数" },
				{ role: "assistant", content: "好的，我来实现" },
			];

			const keyInfo = await manager.extractKeyInfo(messages, {
				objective: "实现加法函数",
				currentStep: 1,
				completedSubtasks: [],
				pendingSubtasks: [],
			});

			expect(keyInfo).toBeDefined();
			expect(keyInfo.taskObjective).toBeDefined();
		});
	});
});
