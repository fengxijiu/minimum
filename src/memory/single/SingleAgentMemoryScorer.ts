import type { MemoryConfidence, MemoryScore } from "../governance/types.js";

export type SingleAgentMemoryScope = "project" | "global";

export interface SingleAgentMemoryCandidate {
	/** Free-form memory text to evaluate. */
	content?: string;
	/** Alias accepted for compatibility with governance memory candidates. */
	body?: string;
	/**
	 * Project memory stays repo-local; global memory can follow the user across
	 * projects.
	 */
	scope: SingleAgentMemoryScope;
	/** Model/user confidence. Defaults to medium when omitted. */
	confidence?: MemoryConfidence | number;
	/**
	 * Evidence such as files, commands, tests, links, or user messages that
	 * support the memory.
	 */
	evidence?: string[];
	/** Alias accepted for governance-style candidates. */
	relatedFiles?: string[];
	/** True when a command/test/user confirmation has verified the statement. */
	verified?: boolean;
	/**
	 * Optional caller-supplied hint that the user explicitly stated a stable
	 * preference.
	 */
	explicitUserPreference?: boolean;
}

export interface SingleAgentMemoryScore extends MemoryScore {
	/** Weighted aggregate used by write thresholds. */
	total: number;
	/** Whether the candidate contains an explicit user preference signal. */
	explicitUserPreference: boolean;
	/** Whether evidence indicates the candidate has been verified. */
	verified: boolean;
}

export interface SingleAgentMemoryRecord {
	content?: string;
	body?: string;
	confidence?: MemoryConfidence | number;
	riskIfWrong?: number;
	risk?: "low" | "medium" | "high" | number;
	verified?: boolean;
}

const CONFIDENCE_TO_NUM: Record<MemoryConfidence, number> = {
	high: 5,
	medium: 3,
	low: 1,
};

const PROJECT_WRITE_THRESHOLD = 13;
const GLOBAL_WRITE_THRESHOLD = 16;
const LOW_CONFIDENCE_CUTOFF = 3;
const HIGH_RISK_CUTOFF = 4;

/**
 * Deterministically score a single-agent memory candidate before persistence.
 *
 * The dimensions mirror governance/MemoryScorer while adding two gates that are
 * important outside the multi-agent governance flow: global memories must be
 * explicit user preferences, and risky memories need verification before use.
 */
export function scoreCandidate(
	candidate: SingleAgentMemoryCandidate,
): SingleAgentMemoryScore {
	const confidence = confidenceScore(candidate.confidence);
	const evidence = evidenceScore(candidate);
	const reuseValue = reuseScore(candidate);
	const stability = stabilityScore(candidate);
	const riskIfWrong = riskScore(candidate);
	const explicitUserPreference = hasExplicitUserPreference(candidate);
	const verified = isVerified(candidate);

	return {
		confidence,
		evidence,
		reuseValue,
		stability,
		riskIfWrong,
		total:
			reuseValue + confidence + evidence + stability - Math.max(0, riskIfWrong - 3),
		explicitUserPreference,
		verified,
	};
}

/**
 * Decide whether a candidate should be written to memory.
 *
 * Project memory has a lower threshold because it is bounded to the repository.
 * Global memory uses a stricter threshold and additionally requires an explicit
 * user preference signal, so incidental facts do not leak across projects.
 */
export function shouldWrite(
	candidate: SingleAgentMemoryCandidate,
	score: SingleAgentMemoryScore = scoreCandidate(candidate),
): boolean {
	if (score.confidence < LOW_CONFIDENCE_CUTOFF) return false;
	if (score.reuseValue < 3 || score.evidence < 2 || score.stability < 3) {
		return false;
	}

	if (candidate.scope === "global") {
		return score.explicitUserPreference && score.total >= GLOBAL_WRITE_THRESHOLD;
	}

	return score.total >= PROJECT_WRITE_THRESHOLD;
}

/**
 * Decide whether a stored memory record is safe enough to inject into context.
 *
 * Low-confidence records are suppressed. High-risk records (for example,
 * security/auth/migration rules) are also suppressed unless the record has been
 * verified, preventing unreviewed safety rules from silently steering the agent.
 */
export function shouldInject(record: SingleAgentMemoryRecord, _query = ""): boolean {
	const confidence = confidenceScore(record.confidence);
	if (confidence < LOW_CONFIDENCE_CUTOFF) return false;

	const riskIfWrong = record.riskIfWrong ?? recordRiskScore(record);
	if (riskIfWrong >= HIGH_RISK_CUTOFF && record.verified !== true) return false;

	return true;
}

function textOf(value: { content?: string; body?: string }): string {
	return (value.content ?? value.body ?? "").trim();
}

function confidenceScore(confidence: MemoryConfidence | number | undefined): number {
	if (typeof confidence === "number") return clamp(Math.round(confidence));
	if (confidence) return CONFIDENCE_TO_NUM[confidence];
	return CONFIDENCE_TO_NUM.medium;
}

function evidenceItems(candidate: SingleAgentMemoryCandidate): string[] {
	return [...(candidate.evidence ?? []), ...(candidate.relatedFiles ?? [])];
}

function evidenceScore(candidate: SingleAgentMemoryCandidate): number {
	let score = 1;
	const evidence = evidenceItems(candidate);
	const text = textOf(candidate).toLowerCase();

	if (evidence.length > 0) score += 2;
	if (evidence.length >= 2) score += 1;
	if (candidate.verified === true || verificationSignals(text, evidence)) {
		score += 1;
	}
	if (text.length > 80) score += 1;

	return clamp(score);
}

function reuseScore(candidate: SingleAgentMemoryCandidate): number {
	const text = textOf(candidate).toLowerCase();
	let score = candidate.scope === "global" ? 2 : 3;

	const reusableSignals = [
		"always",
		"prefer",
		"preference",
		"use ",
		"command",
		"script",
		"convention",
		"rule",
		"must",
		"never",
		"forbidden",
		"workflow",
		"standard",
		"pattern",
	];
	if (reusableSignals.some((signal) => text.includes(signal))) score += 1;
	if (hasExplicitUserPreference(candidate)) score += 2;
	if (evidenceItems(candidate).length > 0) score += 1;

	const oneOffSignals = [
		"today",
		"tomorrow",
		"yesterday",
		"thanks",
		"thank you",
		"hello",
		"weather",
		"joke",
		"one-off",
		"single chat",
	];
	if (oneOffSignals.some((signal) => text.includes(signal))) score -= 2;

	return clamp(score);
}

function stabilityScore(candidate: SingleAgentMemoryCandidate): number {
	const text = textOf(candidate).toLowerCase();
	let score = 4;
	const unstableSignals = [
		"temporary",
		"for now",
		"todo",
		"probably",
		"maybe",
		"guess",
		"unverified",
		"workaround",
		"hack",
		"currently debugging",
	];

	for (const signal of unstableSignals) {
		if (text.includes(signal)) score -= 1;
	}
	if (candidate.verified === true) score += 1;

	return clamp(score);
}

function riskScore(candidate: SingleAgentMemoryCandidate): number {
	return riskFromText(textOf(candidate));
}

function recordRiskScore(record: SingleAgentMemoryRecord): number {
	if (typeof record.risk === "number") return clamp(Math.round(record.risk));
	if (record.risk === "high") return 4;
	if (record.risk === "medium") return 3;
	if (record.risk === "low") return 2;
	return riskFromText(textOf(record));
}

function riskFromText(text: string): number {
	const lower = text.toLowerCase();
	const highRiskSignals = [
		"security",
		"auth",
		"authentication",
		"authorization",
		"password",
		"secret",
		"token",
		"sql",
		"migration",
		"schema change",
		"breaking",
		"delete data",
		"safe to ignore",
		"bypass",
	];

	return highRiskSignals.some((signal) => lower.includes(signal)) ? 4 : 2;
}

function hasExplicitUserPreference(candidate: SingleAgentMemoryCandidate): boolean {
	if (candidate.explicitUserPreference === true) return true;
	const text = textOf(candidate).toLowerCase();
	const preferencePatterns = [
		/\bi prefer\b/,
		/\bi like\b/,
		/\bi want you to\b/,
		/\balways (?:use|do|remember)\b/,
		/\bnever (?:use|do|suggest)\b/,
		/\bmy preference is\b/,
		/\bplease remember\b/,
		/\bremember that i\b/,
		/\buser prefers\b/,
	];
	return preferencePatterns.some((pattern) => pattern.test(text));
}

function isVerified(candidate: SingleAgentMemoryCandidate): boolean {
	return (
		candidate.verified === true ||
		verificationSignals(textOf(candidate), evidenceItems(candidate))
	);
}

function verificationSignals(text: string, evidence: string[]): boolean {
	const lower = `${text}\n${evidence.join("\n")}`.toLowerCase();
	const signals = [
		"verified",
		"passed",
		"confirmed",
		"ran ",
		"exit 0",
		"test passed",
		"✅",
	];
	return signals.some((signal) => lower.includes(signal));
}

function clamp(value: number): number {
	return Math.max(1, Math.min(5, value));
}
