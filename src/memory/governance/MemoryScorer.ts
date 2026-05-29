import type { MemoryCandidate, MemoryScore } from "./types.js";

/**
 * MemoryScorer — deterministic 5-dim scoring used as a pre-LLM gate.
 *
 * Master_planner's W4 LLM call sees only candidates that pass `shouldPersist`.
 * The thresholds are intentionally permissive at the floor (most reasonable
 * candidates pass) so the LLM does the nuanced judgment. The scorer's job is
 * to drop obviously-noise candidates (empty body, "none" scope, low confidence
 * with no evidence).
 */

const CONFIDENCE_TO_NUM: Record<MemoryCandidate["confidence"], number> = {
	high: 5,
	medium: 3,
	low: 1,
};

export function score(c: MemoryCandidate): MemoryScore {
	const evidence = evidenceScore(c);
	const reuseValue = reuseScore(c);
	const stability = stabilityScore(c);
	const risk = riskIfWrong(c);
	return {
		confidence: CONFIDENCE_TO_NUM[c.confidence],
		evidence,
		reuseValue,
		stability,
		riskIfWrong: risk,
	};
}

/**
 * Threshold used by W4: candidates that fail this can be dropped before the
 * LLM ever sees them, saving tokens. Returns true when:
 *  - reuseValue >= 4
 *  - confidence >= 3
 *  - evidence >= 3
 * If riskIfWrong >= 4, the score is still surfaced (master must arbitrate)
 * but the gate is unchanged.
 */
export function shouldPersist(s: MemoryScore): boolean {
	return s.reuseValue >= 4 && s.confidence >= 3 && s.evidence >= 3;
}

export function shouldRequireSecondReview(s: MemoryScore): boolean {
	return s.riskIfWrong >= 4;
}

// ── Per-dimension heuristics ────────────────────────────────────────────────

function evidenceScore(c: MemoryCandidate): number {
	let s = 1;
	if (c.relatedFiles.length > 0) s += 2;
	if (c.relatedFiles.length >= 3) s += 1;
	if (c.body.trim().length > 60) s += 1;
	return Math.min(5, s);
}

function reuseScore(c: MemoryCandidate): number {
	if (c.scope === "none") return 1;
	const body = c.body.toLowerCase();
	let s = 2;
	// Tokens that indicate long-term project knowledge.
	const reuseSignals = [
		"convention",
		"contract",
		"endpoint",
		"command",
		"rule",
		"must",
		"forbidden",
		"layout",
		"schema",
		"pattern",
	];
	for (const tok of reuseSignals) {
		if (body.includes(tok)) { s++; break; }
	}
	if (c.relatedFiles.length > 0) s += 1;
	if (c.confidence === "high") s += 1;
	return Math.min(5, s);
}

function stabilityScore(c: MemoryCandidate): number {
	const body = c.body.toLowerCase();
	// Words that betray ephemerality — drop stability score.
	const ephemeralSignals = [
		"todo",
		"temporary",
		"workaround",
		"hack",
		"for now",
		"will probably",
		"speculation",
		"unverified",
	];
	let s = 4;
	for (const tok of ephemeralSignals) {
		if (body.includes(tok)) { s--; }
	}
	return Math.max(1, Math.min(5, s));
}

function riskIfWrong(c: MemoryCandidate): number {
	const body = c.body.toLowerCase();
	const highRiskSignals = [
		"security",
		"auth",
		"password",
		"token",
		"sql",
		"migration",
		"schema change",
		"breaking",
		"deprecat",
	];
	let s = 2;
	for (const tok of highRiskSignals) {
		if (body.includes(tok)) { s = Math.max(s, 4); }
	}
	return Math.min(5, s);
}
