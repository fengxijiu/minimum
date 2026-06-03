import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MemoryIndex, MemoryIndexEntry } from "../governance/MemoryIndex.js";

export interface MemoryMessage {
	role?: string;
	content: string;
}

export interface RetrieveMemoryQuery {
	input: string;
	messages?: MemoryMessage[];
	maxResults?: number;
}

export interface MemoryRetrieverOptions {
	projectRoot?: string;
	memoryRoot?: string;
	globalMemoryRoot?: string;
	maxResults?: number;
}

export type MemoryLayer = "project" | "global";

export interface RetrievedMemoryEntry {
	layer: MemoryLayer;
	entry: MemoryIndexEntry;
	content: string;
	score: number;
	matched: {
		keywords: string[];
		relatedFiles: string[];
		fields: string[];
	};
}

export interface RetrievedMemory {
	prelude: string;
	entries: RetrievedMemoryEntry[];
	keywords: string[];
	recentFiles: string[];
}

interface IndexedLayer {
	layer: MemoryLayer;
	root: string;
	index: MemoryIndex;
}

const DEFAULT_MEMORY_ROOT = ".minimum";
const DEFAULT_MAX_RESULTS = 5;
const STOP_WORDS = new Set([
	"a",
	"about",
	"all",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"can",
	"do",
	"does",
	"for",
	"from",
	"how",
	"i",
	"in",
	"is",
	"it",
	"me",
	"my",
	"of",
	"on",
	"or",
	"our",
	"please",
	"should",
	"tell",
	"the",
	"to",
	"use",
	"what",
	"when",
	"where",
	"with",
	"you",
	"your",
]);

/**
 * Single-turn memory retrieval over project and global `.minimum/index.json` files.
 *
 * The retriever keeps recall deterministic and cheap: it reads the derived index,
 * reads indexed markdown/json content only for candidate matching, and emits a
 * bounded prelude containing only memories with a positive relevance score.
 */
export class MemoryRetriever {
	private readonly projectRoot: string;
	private readonly memoryRoot: string;
	private readonly globalMemoryRoot: string;
	private readonly maxResults: number;

	constructor(options: MemoryRetrieverOptions = {}) {
		this.projectRoot = options.projectRoot ?? process.cwd();
		this.memoryRoot = options.memoryRoot ?? DEFAULT_MEMORY_ROOT;
		this.globalMemoryRoot = options.globalMemoryRoot ?? path.join(resolveHome(), DEFAULT_MEMORY_ROOT);
		this.maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
	}

	async retrieveMemory(query: string | RetrieveMemoryQuery): Promise<RetrievedMemory> {
		const normalized = normalizeQuery(query);
		const keywords = extractKeywords(normalized.input);
		const recentFiles = extractRecentFiles(normalized.messages ?? [], normalized.input);
		const maxResults = normalized.maxResults ?? this.maxResults;

		const layers = await this.readIndexes();
		const scored: RetrievedMemoryEntry[] = [];

		for (const indexed of layers) {
			for (const entry of indexed.index.entries) {
				if (!entry.exists) continue;
				const content = await readEntryContent(indexed.root, entry);
				const result = scoreEntry(indexed.layer, entry, content, keywords, recentFiles);
				if (result.score <= 0) continue;
				scored.push({
					layer: indexed.layer,
					entry,
					content,
					score: result.score,
					matched: result.matched,
				});
			}
		}

		scored.sort(compareResults);
		const entries = scored.slice(0, maxResults);
		return {
			prelude: renderPrelude(entries),
			entries,
			keywords,
			recentFiles,
		};
	}

	private async readIndexes(): Promise<IndexedLayer[]> {
		const projectIndex = await readIndex(path.join(this.projectRoot, this.memoryRoot, "index.json"));
		const globalIndex = await readIndex(path.join(this.globalMemoryRoot, "index.json"));
		const layers: IndexedLayer[] = [];
		if (projectIndex) layers.push({ layer: "project", root: this.projectRoot, index: projectIndex });
		if (globalIndex) layers.push({ layer: "global", root: path.dirname(this.globalMemoryRoot), index: globalIndex });
		return layers;
	}
}

export async function retrieveMemory(
	query: string | RetrieveMemoryQuery,
	options: MemoryRetrieverOptions = {},
): Promise<RetrievedMemory> {
	return new MemoryRetriever(options).retrieveMemory(query);
}

function normalizeQuery(query: string | RetrieveMemoryQuery): RetrieveMemoryQuery {
	return typeof query === "string" ? { input: query } : query;
}

async function readIndex(filePath: string): Promise<MemoryIndex | null> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf-8")) as MemoryIndex;
	} catch {
		return null;
	}
}

async function readEntryContent(root: string, entry: MemoryIndexEntry): Promise<string> {
	try {
		return await fs.readFile(path.join(root, entry.path), "utf-8");
	} catch {
		return "";
	}
}

function scoreEntry(
	layer: MemoryLayer,
	entry: MemoryIndexEntry,
	content: string,
	keywords: string[],
	recentFiles: string[],
): Pick<RetrievedMemoryEntry, "score" | "matched"> {
	let score = 0;
	const matchedKeywords = new Set<string>();
	const matchedFields = new Set<string>();
	const matchedFiles = new Set<string>();

	const fields: Array<[string, string]> = [
		["key", entry.key ?? ""],
		["tags", entry.tags.join(" ")],
		["scope", entry.scope ?? ""],
		["relatedFiles", entry.relatedFiles.join(" ")],
		["headings", entry.headings.join(" ")],
		["content", content],
	];

	for (const keyword of keywords) {
		for (const [field, rawValue] of fields) {
			if (!rawValue) continue;
			if (containsNeedle(rawValue, keyword)) {
				matchedKeywords.add(keyword);
				matchedFields.add(field);
				score += fieldWeight(field);
			}
		}
	}

	for (const file of recentFiles) {
		const hit = entry.relatedFiles.find((related) => pathsMatch(related, file));
		if (!hit) continue;
		matchedFiles.add(hit);
		matchedFields.add("relatedFiles");
		score += 40;
	}

	if (score <= 0) {
		return { score: 0, matched: { keywords: [], relatedFiles: [], fields: [] } };
	}

	if (layer === "project") score += 8;
	score += confidenceBoost(entry);
	score += recencyBoost(entry.mtimeMs);

	return {
		score,
		matched: {
			keywords: [...matchedKeywords].sort(),
			relatedFiles: [...matchedFiles].sort(),
			fields: [...matchedFields].sort(),
		},
	};
}

function compareResults(a: RetrievedMemoryEntry, b: RetrievedMemoryEntry): number {
	const fileDelta = b.matched.relatedFiles.length - a.matched.relatedFiles.length;
	if (fileDelta !== 0) return fileDelta;
	const layerDelta = layerRank(b.layer) - layerRank(a.layer);
	if (layerDelta !== 0) return layerDelta;
	const confidenceDelta = confidenceRank(b.entry) - confidenceRank(a.entry);
	if (confidenceDelta !== 0) return confidenceDelta;
	const scoreDelta = b.score - a.score;
	if (scoreDelta !== 0) return scoreDelta;
	return b.entry.mtimeMs - a.entry.mtimeMs;
}

function renderPrelude(entries: RetrievedMemoryEntry[]): string {
	if (entries.length === 0) return "";
	const blocks = entries.map((result) => {
		const title = `## ${result.layer}:${result.entry.key ?? result.entry.id ?? result.entry.path}`;
		const meta = `source: ${result.entry.path}; score: ${result.score.toFixed(1)}`;
		const body = result.content.trim() || result.entry.headings.map((heading) => `- ${heading}`).join("\n");
		return `${title}\n${meta}\n\n${body}`;
	});
	return `# Retrieved Memory\n\n${blocks.join("\n\n")}`;
}

export function extractKeywords(input: string): string[] {
	const words = input
		.toLowerCase()
		.match(/[\p{L}\p{N}_-]+/gu) ?? [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const word of words) {
		const normalized = word.replace(/^[-_]+|[-_]+$/g, "");
		if (normalized.length < 2) continue;
		if (STOP_WORDS.has(normalized)) continue;
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

export function extractRecentFiles(messages: MemoryMessage[], input = ""): string[] {
	const recentText = [...messages.slice(-8).map((message) => message.content), input].join("\n");
	const matches = recentText.match(/(?:^|[\s`'"(])((?:\.?\.?\/?[\w@.-]+\/)+[\w@.-]+\.[\w.-]+)(?=$|[\s`'"),.:;])/g) ?? [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const match of matches) {
		const normalized = normalizeRelPath(match.trim().replace(/^[`'"(]+|[`'"),.:;]+$/g, ""));
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

function containsNeedle(rawValue: string, keyword: string): boolean {
	return rawValue.toLowerCase().includes(keyword.toLowerCase());
}

function fieldWeight(field: string): number {
	if (field === "key") return 12;
	if (field === "tags") return 10;
	if (field === "scope") return 8;
	if (field === "relatedFiles") return 14;
	if (field === "headings") return 9;
	return 3;
}

function confidenceBoost(entry: MemoryIndexEntry): number {
	const rank = confidenceRank(entry);
	if (rank === 3) return 10;
	if (rank === 2) return 5;
	if (rank === 1) return 1;
	return 3;
}

function confidenceRank(entry: MemoryIndexEntry): number {
	if (entry.tags.includes("high")) return 3;
	if (entry.tags.includes("medium")) return 2;
	if (entry.tags.includes("low")) return 1;
	return entry.kind === "canonical" ? 2 : 0;
}

function recencyBoost(mtimeMs: number): number {
	if (!mtimeMs) return 0;
	const ageDays = Math.max(0, (Date.now() - mtimeMs) / 86_400_000);
	return Math.max(0, 4 - ageDays / 7);
}

function layerRank(layer: MemoryLayer): number {
	return layer === "project" ? 1 : 0;
}

function pathsMatch(a: string, b: string): boolean {
	const left = normalizeRelPath(a);
	const right = normalizeRelPath(b);
	return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function normalizeRelPath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\s+|\s+$/g, "");
}

function resolveHome(): string {
	// os.homedir() is cross-platform — $HOME is empty on Windows and a literal
	// "~" fallback would turn into a cwd-relative path.
	return os.homedir();
}
