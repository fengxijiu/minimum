import { MemoryStore, type MemoryEntry } from "../MemoryStore.js";
import { ProjectMemory, type ProjectMemoryEntry } from "../ProjectMemory.js";
import type { ChatMessage } from "../../types/common.js";
import { estimateTokens, truncateToTokens } from "../../utils/token-counter.js";

export const MEMORY_PRELUDE_MARKER = "<!-- minimum-memory-prelude -->";

export type MemoryLayer = "project" | "global";

export interface MemoryPreludeRequest {
	userInput: string;
	workingDirectory: string;
	messages: ChatMessage[];
	tokenBudget: number;
	maxRecords?: number;
	projectMemory?: ProjectMemory;
	globalMemory?: MemoryStore;
	globalMemoryPath?: string;
}

export interface IncludedMemoryRecord {
	id: string;
	layer: MemoryLayer;
	key: string;
	confidence: number;
	score: number;
}

export interface MemoryPreludeResult {
	prelude: string;
	includedRecordIds: string[];
	records: IncludedMemoryRecord[];
}

interface RankedRecord {
	id: string;
	layer: MemoryLayer;
	key: string;
	value: string;
	description?: string;
	confidence: number;
	updatedAt: number;
	relevance: number;
	recentness: number;
	layerPriority: number;
	score: number;
}

const DEFAULT_TOKEN_BUDGET = 700;
const DEFAULT_MAX_RECORDS = 8;
const MIN_RELEVANCE_FOR_NONEMPTY_QUERY = 0.02;

/**
 * Build a bounded system prelude from durable project/global memory records.
 *
 * Ranking order is deterministic and follows:
 * relevance → confidence → recentness → layer priority → id.
 */
export async function buildPrelude(
	request: MemoryPreludeRequest,
): Promise<MemoryPreludeResult> {
	const tokenBudget = Math.max(0, request.tokenBudget || DEFAULT_TOKEN_BUDGET);
	if (tokenBudget <= 0) return emptyResult();

	const records = await loadRecords(request);
	if (records.length === 0) return emptyResult();

	const query = buildQuery(request.userInput, request.messages);
	const queryTerms = tokenize(query);
	const now = Date.now();
	const ranked = records
		.map((record) => rankRecord(record, queryTerms, now))
		.filter(
			(record) =>
				queryTerms.size === 0 ||
				record.relevance >= MIN_RELEVANCE_FOR_NONEMPTY_QUERY,
		)
		.sort(compareRankedRecords);

	if (ranked.length === 0) return emptyResult();

	const included: RankedRecord[] = [];
	const maxRecords = request.maxRecords ?? DEFAULT_MAX_RECORDS;
	for (const record of ranked) {
		if (included.length >= maxRecords) break;
		const next = [...included, record];
		const prelude = renderPrelude(next);
		if (estimateTokens(prelude) <= tokenBudget) {
			included.push(record);
			continue;
		}

		// Try a truncated final record if there is still useful budget left.
		const remainingBudget = tokenBudget - estimateTokens(renderPrelude(included));
		if (remainingBudget > 40) {
			const truncated = {
				...record,
				value: truncateToTokens(record.value, Math.max(12, remainingBudget - 24)),
			};
			const withTruncated = [...included, truncated];
			if (estimateTokens(renderPrelude(withTruncated)) <= tokenBudget) {
				included.push(truncated);
			}
		}
		break;
	}

	if (included.length === 0) return emptyResult();
	return {
		prelude: renderPrelude(included),
		includedRecordIds: included.map((record) => record.id),
		records: included.map((record) => ({
			id: record.id,
			layer: record.layer,
			key: record.key,
			confidence: record.confidence,
			score: record.score,
		})),
	};
}

export function isMemoryPreludeMessage(message: ChatMessage): boolean {
	return message.role === "system" && message.content.includes(MEMORY_PRELUDE_MARKER);
}

export function injectMemoryPreludeMessage(
	messages: ChatMessage[],
	prelude: string,
): ChatMessage[] {
	const existingIndex = messages.findIndex(isMemoryPreludeMessage);
	if (!prelude.trim()) {
		return existingIndex >= 0
			? messages.filter((_, index) => index !== existingIndex)
			: messages;
	}

	const nextMessage: ChatMessage = { role: "system", content: prelude };
	if (existingIndex >= 0) {
		return messages.map((message, index) =>
			index === existingIndex ? nextMessage : message,
		);
	}

	let insertAt = 0;
	while (insertAt < messages.length && messages[insertAt]?.role === "system") {
		insertAt++;
	}
	return [
		...messages.slice(0, insertAt),
		nextMessage,
		...messages.slice(insertAt),
	];
}

export function filterMemoryPreludeMessages(messages: ChatMessage[]): ChatMessage[] {
	return messages.filter((message) => !isMemoryPreludeMessage(message));
}

async function loadRecords(request: MemoryPreludeRequest): Promise<RankedRecord[]> {
	const projectMemory = request.projectMemory ?? new ProjectMemory(request.workingDirectory);
	const globalMemory = request.globalMemory ?? new MemoryStore(
		request.globalMemoryPath ? { basePath: request.globalMemoryPath } : {},
	);

	await Promise.all([projectMemory.initialize(), globalMemory.initialize()]);

	const [projectEntries, globalEntries] = await Promise.all([
		projectMemory.list(),
		globalMemory.list(),
	]);

	return [
		...projectEntries.map(projectEntryToRecord),
		...globalEntries
			.filter((entry) => entry.type !== "session")
			.map(globalEntryToRecord),
	];
}

function projectEntryToRecord(entry: ProjectMemoryEntry): RankedRecord {
	return {
		id: `project:${entry.key}`,
		layer: "project",
		key: entry.key,
		value: entry.value,
		description: entry.description,
		confidence: confidenceFromMetadata(undefined),
		updatedAt: entry.updatedAt || entry.createdAt || 0,
		relevance: 0,
		recentness: 0,
		layerPriority: 1,
		score: 0,
	};
}

function globalEntryToRecord(entry: MemoryEntry): RankedRecord {
	return {
		id: `global:${entry.key}`,
		layer: "global",
		key: entry.key,
		value: entry.value,
		description: stringMetadata(entry.metadata?.description),
		confidence: confidenceFromMetadata(entry.metadata),
		updatedAt: entry.timestamp || 0,
		relevance: 0,
		recentness: 0,
		layerPriority: 0,
		score: 0,
	};
}

function rankRecord(
	record: RankedRecord,
	queryTerms: Set<string>,
	now: number,
): RankedRecord {
	const haystack = tokenize(`${record.key} ${record.description ?? ""} ${record.value}`);
	const relevance = relevanceScore(queryTerms, haystack);
	const recentness = recentnessScore(record.updatedAt, now);
	const score =
		relevance * 0.55 +
		record.confidence * 0.25 +
		recentness * 0.12 +
		record.layerPriority * 0.08;
	return { ...record, relevance, recentness, score };
}

function compareRankedRecords(a: RankedRecord, b: RankedRecord): number {
	return (
		b.relevance - a.relevance ||
		b.confidence - a.confidence ||
		b.recentness - a.recentness ||
		b.layerPriority - a.layerPriority ||
		a.id.localeCompare(b.id)
	);
}

function buildQuery(userInput: string, messages: ChatMessage[]): string {
	const recentMessages = messages
		.filter((message) => message.role === "user" || message.role === "assistant")
		.slice(-6)
		.map((message) => message.content)
		.join("\n");
	return `${userInput}\n${recentMessages}`;
}

function tokenize(text: string): Set<string> {
	const tokens = text
		.toLowerCase()
		.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
	return new Set(tokens);
}

function relevanceScore(queryTerms: Set<string>, recordTerms: Set<string>): number {
	if (queryTerms.size === 0) return 0;
	let hits = 0;
	for (const term of queryTerms) {
		if (recordTerms.has(term)) hits++;
	}
	return hits / queryTerms.size;
}

function recentnessScore(timestamp: number, now: number): number {
	if (!timestamp) return 0;
	const ageDays = Math.max(0, (now - timestamp) / 86_400_000);
	return 1 / (1 + ageDays / 30);
}

function confidenceFromMetadata(metadata?: Record<string, any>): number {
	const raw = metadata?.confidence;
	if (typeof raw === "number" && Number.isFinite(raw)) return clamp01(raw);
	if (typeof raw !== "string") return 0.6;
	switch (raw.toLowerCase()) {
		case "high":
			return 0.9;
		case "medium":
			return 0.6;
		case "low":
			return 0.3;
		default: {
			const parsed = Number(raw);
			return Number.isFinite(parsed) ? clamp01(parsed) : 0.6;
		}
	}
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function stringMetadata(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function renderPrelude(records: RankedRecord[]): string {
	const lines = [
		MEMORY_PRELUDE_MARKER,
		"You have access to selected durable memory records relevant to this turn. Treat them as hints, not absolute truth; prefer the repository and user instructions when they conflict.",
		"",
		"## Relevant memory",
	];

	for (const record of records) {
		lines.push(
			`- **${record.layer}:${record.key}** (confidence ${record.confidence.toFixed(2)}, score ${record.score.toFixed(3)})`,
		);
		if (record.description) lines.push(`  - ${record.description}`);
		lines.push(`  - ${record.value.replace(/\n/g, "\n    ")}`);
	}

	lines.push("", `Included record ids: ${records.map((record) => record.id).join(", ")}`);
	return lines.join("\n");
}

function emptyResult(): MemoryPreludeResult {
	return { prelude: "", includedRecordIds: [], records: [] };
}
