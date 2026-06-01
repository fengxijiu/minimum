import type { CurrentTask, MemoryLayer, MemoryRecord } from "./types.js";

const LAYER_PRIORITY: Record<MemoryLayer, number> = {
	session: 3,
	project: 2,
	global: 1,
};

const CONFIDENCE_PRIORITY: Record<string, number> = {
	high: 3,
	medium: 2,
	low: 1,
};

export function resolveMemory(
	records: MemoryRecord[],
	currentTask: string | CurrentTask = "",
): MemoryRecord[] {
	const explicitTerms = extractExplicitTerms(currentTask);
	const candidates = records.filter(
		(record) => !isOverriddenByCurrentTask(record, explicitTerms),
	);
	const resolved: MemoryRecord[] = [];

	for (const record of candidates) {
		const conflictIndex = resolved.findIndex((existing) =>
			isSameMemoryClass(existing, record),
		);

		if (conflictIndex === -1) {
			resolved.push(record);
			continue;
		}

		const existing = resolved[conflictIndex];
		if (existing && shouldPrefer(record, existing)) {
			resolved[conflictIndex] = record;
		}
	}

	return resolved.sort(compareForOutput);
}

function isSameMemoryClass(left: MemoryRecord, right: MemoryRecord): boolean {
	return (
		normalize(left.key) === normalize(right.key) ||
		normalize(left.scope) === normalize(right.scope)
	);
}

function shouldPrefer(candidate: MemoryRecord, current: MemoryRecord): boolean {
	if (candidate.layer === "session" && current.layer !== "session") return true;
	if (candidate.layer !== "session" && current.layer === "session") return false;

	if (candidate.layer === "project" && current.layer === "global") return true;
	if (candidate.layer === "global" && current.layer === "project") return false;

	const confidenceDelta = confidenceScore(candidate) - confidenceScore(current);
	if (confidenceDelta !== 0) return confidenceDelta > 0;

	const updatedAtDelta = updatedAtScore(candidate) - updatedAtScore(current);
	if (updatedAtDelta !== 0) return updatedAtDelta > 0;

	return LAYER_PRIORITY[candidate.layer] > LAYER_PRIORITY[current.layer];
}

function compareForOutput(left: MemoryRecord, right: MemoryRecord): number {
	const layerDelta = LAYER_PRIORITY[right.layer] - LAYER_PRIORITY[left.layer];
	if (layerDelta !== 0) return layerDelta;

	const confidenceDelta = confidenceScore(right) - confidenceScore(left);
	if (confidenceDelta !== 0) return confidenceDelta;

	return updatedAtScore(right) - updatedAtScore(left);
}

function confidenceScore(record: MemoryRecord): number {
	if (typeof record.confidence === "number") return record.confidence;
	return CONFIDENCE_PRIORITY[record.confidence] ?? 0;
}

function updatedAtScore(record: MemoryRecord): number {
	const value = record.updatedAt;
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") return value;

	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function extractExplicitTerms(currentTask: string | CurrentTask): Set<string> {
	const terms = new Set<string>();
	const addTokens = (value: string | undefined) => {
		if (!value) return;
		for (const token of tokenize(value)) terms.add(token);
	};

	if (typeof currentTask === "string") {
		addTokens(currentTask);
		return terms;
	}

	addTokens(currentTask.input);
	addTokens(currentTask.prompt);
	addTokens(currentTask.content);
	for (const preference of currentTask.explicitPreferences ?? []) {
		addTokens(preference);
	}

	return terms;
}

function isOverriddenByCurrentTask(
	record: MemoryRecord,
	explicitTerms: Set<string>,
): boolean {
	if (explicitTerms.size === 0 || record.layer === "session") return false;

	const keyTokens = tokenize(record.key);
	const scopeTokens = tokenize(record.scope);
	return (
		keyTokens.some((token) => explicitTerms.has(token)) ||
		scopeTokens.some((token) => explicitTerms.has(token))
	);
}

function tokenize(value: string): string[] {
	return normalize(value)
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

function normalize(value: string): string {
	return value.trim().toLocaleLowerCase();
}
