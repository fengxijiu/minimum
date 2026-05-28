import { describe, expect, it } from "vitest";
import {
	expectNonEmptyArray,
	expectStringContains,
	expectToHaveProperties,
	expectValidDate,
} from "./helpers/assertions";
import {
	createMockCompletenessRequest,
	createMockCompletenessResult,
	createMockConfig,
	createMockContextOptimizeRequest,
	createMockFileSystem,
	createMockIterationTask,
	createMockMessage,
	createMockToolCall,
	createMockToolResult,
	createMockValidationRequest,
	createMockValidationResult,
} from "./helpers/mock-factory";
import {
	captureError,
	cleanupTempDir,
	createTempDir,
	createTempFile,
	deepClone,
	deepEqual,
	delay,
	randomInt,
	randomString,
	waitFor,
} from "./helpers/test-utils";

describe("Test Helpers", () => {
	describe("test-utils", () => {
		it("should create and cleanup temp directory", async () => {
			const dir = await createTempDir();
			expect(dir).toContain("minimum-test-");
			await cleanupTempDir(dir);
		});

		it("should create temp file", async () => {
			const filePath = await createTempFile("test content");
			expect(filePath).toContain("test.ts");
			await cleanupTempDir(filePath.replace("/test.ts", ""));
		});

		it("should generate random string", () => {
			const str = randomString(10);
			expect(str.length).toBe(10);
		});

		it("should generate random integer", () => {
			const num = randomInt(1, 100);
			expect(num).toBeGreaterThanOrEqual(1);
			expect(num).toBeLessThanOrEqual(100);
		});

		it("should delay execution", async () => {
			const start = Date.now();
			await delay(100);
			const elapsed = Date.now() - start;
			expect(elapsed).toBeGreaterThanOrEqual(90);
		});

		it("should deep clone object", () => {
			const obj = { a: 1, b: { c: 2 } };
			const cloned = deepClone(obj);
			expect(cloned).toEqual(obj);
			expect(cloned).not.toBe(obj);
		});

		it("should compare objects deeply", () => {
			expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true);
			expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
		});

		it("should capture async error", async () => {
			const error = await captureError(async () => {
				throw new Error("test error");
			});
			expect(error).toBeInstanceOf(Error);
			expect(error?.message).toBe("test error");
		});

		it("should return null when no error", async () => {
			const error = await captureError(async () => {});
			expect(error).toBeNull();
		});

		it("should wait for condition", async () => {
			let count = 0;
			await waitFor(() => {
				count++;
				return count >= 3;
			});
			expect(count).toBeGreaterThanOrEqual(3);
		});
	});

	describe("mock-factory", () => {
		it("should create mock message", () => {
			const msg = createMockMessage("user", "hello");
			expect(msg.role).toBe("user");
			expect(msg.content).toBe("hello");
		});

		it("should create mock tool call", () => {
			const call = createMockToolCall("test_tool", { arg: "value" });
			expect(call.type).toBe("function");
			expect(call.function.name).toBe("test_tool");
		});

		it("should create mock tool result", () => {
			const result = createMockToolResult("success", false);
			expect(result.content).toBe("success");
			expect(result.isError).toBe(false);
		});

		it("should create mock validation request", () => {
			const req = createMockValidationRequest("my_tool");
			expect(req.toolName).toBe("my_tool");
		});

		it("should create mock validation result", () => {
			const result = createMockValidationResult(true);
			expect(result.passed).toBe(true);
			expect(result.checks.length).toBeGreaterThan(0);
		});

		it("should create mock completeness request", () => {
			const req = createMockCompletenessRequest("my task");
			expect(req.task).toBe("my task");
		});

		it("should create mock completeness result", () => {
			const result = createMockCompletenessResult(true);
			expect(result.complete).toBe(true);
			expect(result.score).toBe(100);
		});

		it("should create mock context optimize request", () => {
			const req = createMockContextOptimizeRequest();
			expect(req.messages.length).toBe(2);
			expect(req.maxTokens).toBe(8000);
		});

		it("should create mock iteration task", () => {
			const task = createMockIterationTask();
			expect(task.id).toBe("test-task-1");
			expect(task.maxRetries).toBe(3);
		});

		it("should create mock file system", () => {
			const fs = createMockFileSystem();
			expect(Object.keys(fs).length).toBe(4);
		});

		it("should create mock config", () => {
			const config = createMockConfig();
			expect(config.model).toBe("mimo-v2.5-pro");
		});
	});

	describe("assertions", () => {
		it("should check object properties", () => {
			const obj = { a: 1, b: 2, c: 3 };
			expectToHaveProperties(obj, "a", "b", "c");
		});

		it("should check non-empty array", () => {
			expectNonEmptyArray([1, 2, 3]);
		});

		it("should check string contains", () => {
			expectStringContains("hello world", "world");
		});

		it("should check valid date", () => {
			expectValidDate(Date.now());
			expectValidDate(new Date());
		});
	});
});
