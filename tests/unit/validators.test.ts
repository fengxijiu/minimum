import { beforeEach, describe, expect, it } from "vitest";
import { CodeValidator } from "../../src/validators/CodeValidator.js";
import { PatternChecker } from "../../src/validators/PatternChecker.js";
import { SyntaxChecker } from "../../src/validators/SyntaxChecker.js";
import { TypeChecker } from "../../src/validators/TypeChecker.js";

describe("Validators", () => {
	describe("SyntaxChecker", () => {
		let checker: SyntaxChecker;

		beforeEach(() => {
			checker = new SyntaxChecker();
		});

		it("should validate correct JSON", async () => {
			const result = await checker.check({
				toolName: "write_file",
				toolArgs: { path: "test.json" },
				toolResult: { content: '{"key": "value"}' },
				filePath: "test.json",
			});

			expect(result).toBeDefined();
			expect(result.length).toBeGreaterThan(0);
			expect(result[0].passed).toBe(true);
		});

		it("should detect invalid JSON", async () => {
			const result = await checker.check({
				toolName: "write_file",
				toolArgs: { path: "test.json" },
				toolResult: { content: '{"key": "value"' },
				filePath: "test.json",
			});

			expect(result).toBeDefined();
			expect(result.some((r) => !r.passed)).toBe(true);
		});

		it("should return empty checks for unsupported file types", async () => {
			const result = await checker.check({
				toolName: "write_file",
				toolArgs: { path: "test.xyz" },
				toolResult: { content: "some content" },
				filePath: "test.xyz",
			});

			expect(result).toBeDefined();
			expect(result.length).toBe(0);
		});
	});

	describe("TypeChecker", () => {
		let checker: TypeChecker;

		beforeEach(() => {
			checker = new TypeChecker();
		});

		it("should detect any type usage", async () => {
			const result = await checker.check({
				toolName: "write_file",
				toolArgs: { path: "test.ts" },
				toolResult: { content: "const x: any = 5;" },
			});

			expect(result).toBeDefined();
			expect(result.some((r) => r.message.includes("any"))).toBe(true);
		});

		it("should detect undefined usage without typeof", async () => {
			const result = await checker.check({
				toolName: "write_file",
				toolArgs: { path: "test.ts" },
				toolResult: { content: "const x = undefined;" },
			});

			expect(result).toBeDefined();
			expect(result.some((r) => r.message.includes("undefined"))).toBe(true);
		});

		it("should pass for clean code", async () => {
			const result = await checker.check({
				toolName: "write_file",
				toolArgs: { path: "test.ts" },
				toolResult: { content: "const x: number = 5;" },
			});

			expect(result).toBeDefined();
			expect(result[0].passed).toBe(true);
		});
	});

	describe("PatternChecker", () => {
		let checker: PatternChecker;

		beforeEach(() => {
			checker = new PatternChecker();
		});

		it("should detect TODO markers", async () => {
			const result = await checker.check({
				toolName: "write_file",
				toolArgs: { path: "test.ts" },
				toolResult: { content: "// TODO: implement this" },
			});

			expect(result).toBeDefined();
			expect(result.some((r) => r.message.includes("TODO"))).toBe(true);
		});

		it("should detect console.log", async () => {
			const result = await checker.check({
				toolName: "write_file",
				toolArgs: { path: "test.ts" },
				toolResult: { content: 'console.log("debug");' },
			});

			expect(result).toBeDefined();
			expect(result.some((r) => r.message.includes("console.log"))).toBe(true);
		});

		it("should detect sensitive data patterns", async () => {
			const result = await checker.check({
				toolName: "write_file",
				toolArgs: { path: "test.ts" },
				toolResult: { content: 'const password = "secret123";' },
			});

			expect(result).toBeDefined();
			expect(result.some((r) => r.message.includes("sensitive"))).toBe(true);
		});

		it("should pass for clean code", async () => {
			const result = await checker.check({
				toolName: "write_file",
				toolArgs: { path: "test.ts" },
				toolResult: { content: "const x = 5;" },
			});

			expect(result).toBeDefined();
			expect(result[0].passed).toBe(true);
		});
	});

	describe("CodeValidator", () => {
		let validator: CodeValidator;

		beforeEach(() => {
			validator = new CodeValidator();
		});

		it("should validate valid code", async () => {
			const result = await validator.validate({
				toolName: "write_file",
				toolArgs: { path: "test.ts" },
				toolResult: { content: "export function test() { return true; }" },
			});

			expect(result).toBeDefined();
			expect(result.passed).toBe(true);
		});

		it("should detect issues in code", async () => {
			const result = await validator.validate({
				toolName: "write_file",
				toolArgs: { path: "test.ts" },
				toolResult: { content: "const x: any = 5; // TODO: fix" },
			});

			expect(result).toBeDefined();
			expect(result.checks.length).toBeGreaterThan(0);
		});

		it("should register custom checker", () => {
			const customChecker = new SyntaxChecker();
			validator.registerChecker(customChecker);
			expect(validator).toBeDefined();
		});

		it("should enable and disable checkers", () => {
			validator.setCheckerEnabled("type", false);
			expect(validator).toBeDefined();
			validator.setCheckerEnabled("type", true);
		});
	});
});
