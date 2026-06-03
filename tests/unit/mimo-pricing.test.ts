import { describe, expect, it } from "vitest";
import {
	computeTurnCost,
	currencyFor,
	resolveBillingMode,
} from "../../src/clients/MiMoPricing.js";

describe("MiMoPricing", () => {
	describe("resolveBillingMode", () => {
		it("treats tp- keys as Token Plan", () => {
			expect(resolveBillingMode("tp-abc123")).toBe("tokenPlan");
		});
		it("treats sk- keys as pay-as-you-go API", () => {
			expect(resolveBillingMode("sk-abc123")).toBe("api");
		});
		it("treats undefined / empty key as api by default", () => {
			expect(resolveBillingMode(undefined)).toBe("api");
			expect(resolveBillingMode("")).toBe("api");
		});
	});

	describe("currencyFor", () => {
		it("Token Plan → Credits, API → CNY", () => {
			expect(currencyFor("tokenPlan")).toBe("Credits");
			expect(currencyFor("api")).toBe("CNY");
		});
	});

	describe("computeTurnCost (API CNY)", () => {
		it("prices pro: 1 M fresh input = ¥3, 1 M output = ¥6", () => {
			const out = computeTurnCost(
				{ promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 },
				"mimo-v2.5-pro",
				"api",
			);
			expect(out.currency).toBe("CNY");
			expect(out.freshCost).toBeCloseTo(3);
			expect(out.outputCost).toBeCloseTo(6);
			expect(out.cachedCost).toBeCloseTo(0);
			expect(out.cost).toBeCloseTo(9);
		});

		it("splits cached vs fresh correctly", () => {
			// 800k prompt, 200k cached → 600k fresh
			const out = computeTurnCost(
				{ promptTokens: 800_000, completionTokens: 0, cachedTokens: 200_000 },
				"mimo-v2.5-pro",
				"api",
			);
			expect(out.cachedCost).toBeCloseTo(0.005); // 200k * 0.025 / 1M
			expect(out.freshCost).toBeCloseTo(1.8); // 600k * 3 / 1M
		});

		it("prices base mimo-v2.5 cheaper than pro", () => {
			const pro = computeTurnCost(
				{ promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 },
				"mimo-v2.5-pro",
				"api",
			);
			const base = computeTurnCost(
				{ promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 },
				"mimo-v2.5",
				"api",
			);
			expect(base.cost).toBeLessThan(pro.cost);
			expect(base.cost).toBeCloseTo(3); // ¥1 + ¥2
		});
	});

	describe("computeTurnCost (Token Plan Credits)", () => {
		it("prices pro in credits: 1 M fresh + 1 M output = 900 C", () => {
			const out = computeTurnCost(
				{ promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 },
				"mimo-v2.5-pro",
				"tokenPlan",
			);
			expect(out.currency).toBe("Credits");
			expect(out.cost).toBeCloseTo(900); // 300 fresh + 600 output
		});
	});

	describe("computeTurnCost edge cases", () => {
		it("unknown model returns zero cost without throwing", () => {
			const out = computeTurnCost(
				{ promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 },
				"mimo-v9-future",
				"api",
			);
			expect(out.cost).toBe(0);
			expect(out.currency).toBe("CNY");
		});

		it("cachedTokens > promptTokens clamps fresh to 0", () => {
			const out = computeTurnCost(
				{ promptTokens: 100, completionTokens: 0, cachedTokens: 500 },
				"mimo-v2.5-pro",
				"api",
			);
			expect(out.freshCost).toBe(0);
		});
	});
});
