/**
 * MiMo pricing tables and cost computation.
 *
 * Two parallel pricing schemes coexist:
 *   • API pay-as-you-go (sk- keys)  →  priced in CNY per million tokens
 *   • Token Plan         (tp- keys) →  priced in Credits per million tokens
 *
 * Source: https://platform.xiaomimimo.com/ pricing page (as of 2026-06).
 * Update both tables together if either scheme's rates change.
 */

export type Currency = "CNY" | "Credits";
export type BillingMode = "api" | "tokenPlan";

export interface PriceRow {
	/** Price per million tokens for input that hit the prefix cache. */
	cached: number;
	/** Price per million tokens for fresh (uncached) input. */
	fresh: number;
	/** Price per million tokens for output (includes reasoning tokens). */
	output: number;
}

const API_PRICES_CNY: Record<string, PriceRow> = {
	"mimo-v2.5-pro": { cached: 0.025, fresh: 3, output: 6 },
	"mimo-v2.5": { cached: 0.02, fresh: 1, output: 2 },
};

const TOKEN_PLAN_PRICES_CREDITS: Record<string, PriceRow> = {
	"mimo-v2.5-pro": { cached: 2.5, fresh: 300, output: 600 },
	"mimo-v2.5": { cached: 2, fresh: 100, output: 200 },
};

/** Token Plan keys start with "tp-"; everything else is treated as pay-as-you-go API. */
export function resolveBillingMode(apiKey: string | undefined): BillingMode {
	return apiKey?.startsWith("tp-") ? "tokenPlan" : "api";
}

/** Currency unit a given billing mode is denominated in. */
export function currencyFor(mode: BillingMode): Currency {
	return mode === "tokenPlan" ? "Credits" : "CNY";
}

function priceRow(model: string, mode: BillingMode): PriceRow | undefined {
	const table = mode === "tokenPlan" ? TOKEN_PLAN_PRICES_CREDITS : API_PRICES_CNY;
	return table[model];
}

export interface UsageSplit {
	promptTokens: number;
	completionTokens: number;
	/** Subset of promptTokens that hit the prefix cache. */
	cachedTokens: number;
}

export interface CostBreakdown {
	cost: number;
	currency: Currency;
	/** Per-component breakdown so callers can show "$x fresh · $y cached · $z output". */
	freshCost: number;
	cachedCost: number;
	outputCost: number;
}

/**
 * Compute the cost of a single turn's usage record. Returns 0 for unknown
 * models so unknown deployments still tick the counter forward — caller can
 * detect zero pricing and surface a warning if needed.
 */
export function computeTurnCost(
	usage: UsageSplit,
	model: string,
	mode: BillingMode,
): CostBreakdown {
	const currency = currencyFor(mode);
	const row = priceRow(model, mode);
	if (!row) {
		return { cost: 0, currency, freshCost: 0, cachedCost: 0, outputCost: 0 };
	}
	const cached = Math.max(0, usage.cachedTokens);
	const fresh = Math.max(0, usage.promptTokens - cached);
	const output = Math.max(0, usage.completionTokens);
	const cachedCost = (cached * row.cached) / 1_000_000;
	const freshCost = (fresh * row.fresh) / 1_000_000;
	const outputCost = (output * row.output) / 1_000_000;
	return {
		cost: cachedCost + freshCost + outputCost,
		currency,
		freshCost,
		cachedCost,
		outputCost,
	};
}
