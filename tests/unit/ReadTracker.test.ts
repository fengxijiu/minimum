import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ReadTracker } from "../../src/loop/ReadTracker.js";

describe("ReadTracker (canonical from src/loop)", () => {
	it("初始未读返回 false", () => {
		const t = new ReadTracker();
		expect(t.hasRead("/tmp/foo")).toBe(false);
	});

	it("markRead 后 hasRead 返回 true", () => {
		const t = new ReadTracker();
		t.markRead("/tmp/foo");
		expect(t.hasRead("/tmp/foo")).toBe(true);
	});

	it("workingDirectory 解析:相对路径 + cwd ≡ 绝对路径", () => {
		const t = new ReadTracker();
		t.markRead("a/b/c.txt", "/work");
		expect(t.hasRead(path.resolve("/work", "a/b/c.txt"))).toBe(true);
	});

	it("guardEdit 未读返回错误字符串", () => {
		const t = new ReadTracker();
		const msg = t.guardEdit("foo.txt");
		expect(msg).toMatch(/not been read yet/i);
	});

	it("guardEdit 已读返回 null", () => {
		const t = new ReadTracker();
		t.markRead("foo.txt");
		expect(t.guardEdit("foo.txt")).toBeNull();
	});

	it("reset 清空所有已读路径", () => {
		const t = new ReadTracker();
		t.markRead("/x");
		t.reset();
		expect(t.hasRead("/x")).toBe(false);
	});
});
