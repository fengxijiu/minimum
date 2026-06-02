import { describe, expect, it } from "vitest";
import {
	parseCommandChain,
	chainAllowed,
	isNullDeviceAlias,
} from "../../src/tools/shell/shell-chain.js";

describe("parseCommandChain", () => {
	it("单段命令返回 null(不是 chain)", () => {
		expect(parseCommandChain("ls -la")).toBeNull();
	});
	it("pipe 链 segments 数量正确", () => {
		const c = parseCommandChain("a | b | c");
		expect(c).not.toBeNull();
		expect(c!.segments).toHaveLength(3);
		expect(c!.ops).toEqual(["|", "|"]);
	});
	it("&& 与 || 组合", () => {
		const c = parseCommandChain("a && b || c");
		expect(c!.ops).toEqual(["&&", "||"]);
	});
	it("> 重定向落到 segment.redirects", () => {
		const c = parseCommandChain("echo hi > out.txt");
		expect(c).not.toBeNull();
		expect(c!.segments[0]!.redirects).toEqual([
			{ kind: ">", target: "out.txt" },
		]);
	});
	it("2>&1 不要 target", () => {
		const c = parseCommandChain("foo 2>&1");
		expect(c!.segments[0]!.redirects[0]).toEqual({ kind: "2>&1", target: "" });
	});
});

describe("isNullDeviceAlias", () => {
	it("/dev/null 是 null device", () => {
		expect(isNullDeviceAlias("/dev/null")).toBe(true);
	});
	it("NUL(Windows)是 null device", () => {
		expect(isNullDeviceAlias("NUL")).toBe(true);
	});
	it("普通文件不是", () => {
		expect(isNullDeviceAlias("out.txt")).toBe(false);
	});
});

describe("chainAllowed", () => {
	it("全部 segment 通过 → allowed", () => {
		const c = parseCommandChain("ls | grep x");
		expect(chainAllowed(c!, () => true)).toBe(true);
	});
	it("任一 segment 失败 → not allowed", () => {
		const c = parseCommandChain("ls | rm");
		let i = 0;
		expect(chainAllowed(c!, () => i++ === 0)).toBe(false);
	});
});
