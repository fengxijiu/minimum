import { describe, expect, it } from "vitest";
import { getContextUsageK } from "../../tui/src/context-usage.js";

describe("getContextUsageK", () => {
	it("prefers live contextTokens over total session tokens", () => {
		expect(
			getContextUsageK({
				contextTokens: 600,
				promptTokens: 1200,
				totalTokens: 3000,
			}),
		).toBe(0.6);
	});

	it("falls back to promptTokens when contextTokens is missing", () => {
		expect(
			getContextUsageK({
				promptTokens: 1500,
				totalTokens: 9000,
			}),
		).toBe(1.5);
	});

	it("returns zero when no token fields are present", () => {
		expect(getContextUsageK({})).toBe(0);
	});
});
