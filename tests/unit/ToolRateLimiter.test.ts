import { describe, expect, it } from "vitest";
import {
	ToolRateLimiter,
	normalizeToolRateLimitConfig,
	parseRateLimitedToolResult,
	DEFAULT_TOOL_RATE_LIMIT,
} from "../../src/tools/limits/ToolRateLimiter.js";
import type { RateLimitedToolResult } from "../../src/tools/limits/ToolRateLimiter.js";

describe("ToolRateLimiter", () => {
	it("默认配置归一化", () => {
		const cfg = normalizeToolRateLimitConfig({});
		expect(cfg).not.toBe(false);
		if (cfg === false) return;
		expect(cfg.aggregate).toEqual(DEFAULT_TOOL_RATE_LIMIT.aggregate);
	});

	it("enabled:false 时彻底禁用", () => {
		const limiter = new ToolRateLimiter({ enabled: false });
		expect(limiter.consume("any")).toEqual({ allowed: true });
	});
});

describe("ToolRateLimiter 滑动窗口", () => {
	it("达到 maxCalls 后拒绝,retryAfterMs > 0", () => {
		let t = 1_000_000;
		const limiter = new ToolRateLimiter(
			{ aggregate: { maxCalls: 3, windowSeconds: 10 } },
			() => t,
		);
		expect(limiter.consume("a").allowed).toBe(true);
		expect(limiter.consume("a").allowed).toBe(true);
		expect(limiter.consume("a").allowed).toBe(true);
		const blocked = limiter.consume("a");
		expect(blocked.allowed).toBe(false);
		if (blocked.allowed) return;
		expect(blocked.result.scope).toBe("all_tools");
		expect(blocked.result.retryAfterMs).toBeGreaterThan(0);
	});

	it("窗口滑过后旧时间戳被丢弃", () => {
		let t = 0;
		const limiter = new ToolRateLimiter(
			{ aggregate: { maxCalls: 2, windowSeconds: 1 } },
			() => t,
		);
		limiter.consume("x");
		limiter.consume("x");
		expect(limiter.consume("x").allowed).toBe(false);
		t += 1_500;
		expect(limiter.consume("x").allowed).toBe(true);
	});

	it("per-tool 桶独立限制", () => {
		let t = 0;
		const limiter = new ToolRateLimiter(
			{
				aggregate: { maxCalls: 100, windowSeconds: 60 },
				tools: { foo: { maxCalls: 1, windowSeconds: 60 } },
			},
			() => t,
		);
		expect(limiter.consume("foo").allowed).toBe(true);
		const blocked = limiter.consume("foo");
		expect(blocked.allowed).toBe(false);
		if (!blocked.allowed) expect(blocked.result.scope).toBe("foo");
		expect(limiter.consume("bar").allowed).toBe(true);
	});

	it("tools[name]=false 禁用该工具的桶但聚合仍计数", () => {
		let t = 0;
		const limiter = new ToolRateLimiter(
			{
				aggregate: { maxCalls: 3, windowSeconds: 60 },
				tools: { exec_shell: false },
			},
			() => t,
		);
		// per-tool bucket disabled → no individual cap
		expect(limiter.consume("exec_shell").allowed).toBe(true);
		expect(limiter.consume("exec_shell").allowed).toBe(true);
		expect(limiter.consume("exec_shell").allowed).toBe(true);
		// aggregate still fires after 3 calls
		const blocked = limiter.consume("exec_shell");
		expect(blocked.allowed).toBe(false);
		if (!blocked.allowed) expect(blocked.result.scope).toBe("all_tools");
	});
});

describe("parseRateLimitedToolResult", () => {
	it("valid rate-limited JSON を解析", () => {
		const payload: RateLimitedToolResult = {
			error: "rate_limited",
			tool: "exec_shell",
			scope: "all_tools",
			limit: 60,
			windowSeconds: 60,
			retryAfterMs: 5000,
			message: "all_tools rate-limited: 60 calls / 60s. Wait 5s or summarize what you know.",
		};
		expect(parseRateLimitedToolResult(JSON.stringify(payload))).toEqual(payload);
	});

	it("非 JSON 文字列は null を返す", () => {
		expect(parseRateLimitedToolResult("not json")).toBeNull();
	});

	it("error フィールドが rate_limited でなければ null", () => {
		expect(parseRateLimitedToolResult(JSON.stringify({ error: "other" }))).toBeNull();
	});

	it("フィールド欠如は null", () => {
		expect(parseRateLimitedToolResult(JSON.stringify({ error: "rate_limited", tool: "x" }))).toBeNull();
	});
});
