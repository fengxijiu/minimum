import { describe, expect, it } from "vitest";
import {
	tokenizeCommand,
	detectShellOperator,
	isAllowed,
	isCommandAllowed,
	hasSensitivePathArgs,
	derivePrefix,
	BUILTIN_ALLOWLIST,
} from "../../src/tools/shell/parse.js";
import { classifyCommand } from "../../src/tools/shell/policy/ShellClassifier.js";

describe("tokenizeCommand", () => {
	it("简单空格分词", () => {
		expect(tokenizeCommand("ls -la")).toEqual(["ls", "-la"]);
	});
	it("双引号保护空格", () => {
		expect(tokenizeCommand('echo "hello world"')).toEqual(["echo", "hello world"]);
	});
	it("Windows 路径里的反斜杠保留", () => {
		expect(tokenizeCommand('cat "C:\\Users\\foo\\.bar"')).toEqual([
			"cat",
			"C:\\Users\\foo\\.bar",
		]);
	});
	it("未闭合引号抛错", () => {
		expect(() => tokenizeCommand('echo "unclosed')).toThrow(/unclosed/);
	});
});

describe("detectShellOperator", () => {
	it("识别裸 pipe", () => {
		expect(detectShellOperator("ls | grep x")).toBe("|");
	});
	it("识别 &&", () => {
		expect(detectShellOperator("a && b")).toBe("&&");
	});
	it("引号内的 | 不算操作符", () => {
		expect(detectShellOperator('grep "a|b" file')).toBeNull();
	});
	it("纯命令返回 null", () => {
		expect(detectShellOperator("ls -la")).toBeNull();
	});
});

describe("isAllowed (单段命令)", () => {
	it("git status 在 BUILTIN_ALLOWLIST 里", () => {
		expect(isAllowed("git status")).toBe(true);
	});
	it("rm -rf 不在 allowlist", () => {
		expect(isAllowed("rm -rf /")).toBe(false);
	});
	it("RISKY_ARGS:git branch -D 被降级", () => {
		expect(isAllowed("git branch foo")).toBe(true);
		expect(isAllowed("git branch -D foo")).toBe(false);
	});
});

describe("derivePrefix", () => {
	it('"git diff foo" → "git diff"', () => {
		expect(derivePrefix("git diff foo")).toBe("git diff");
	});
	it('"ls -la" → "ls -la"', () => {
		expect(derivePrefix("ls -la")).toBe("ls -la");
	});
	it("空串返回空", () => {
		expect(derivePrefix("")).toBe("");
	});
});

describe("shell git read policy", () => {
	it("classifies git ls-files as read-only git access", () => {
		const decision = classifyCommand("git ls-files", {
			cwd: process.cwd(),
			allowedCategories: ["git_read"],
			rawEnabled: false,
			sensitivePathMode: "warn",
		});
		expect(decision.ok).toBe(true);
		expect(decision.category).toBe("git_read");
		expect(decision.effect).toBe("read_only");
		expect(decision.requiresApproval).toBe(false);
	});
});
