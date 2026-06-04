import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { estimateTokens } from "../../utils/token-counter.js";
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
	/** Soft cap on total prelude tokens; entries are added until this is hit. */
	maxTokens?: number;
	/** Minimum entries guaranteed per layer (when that layer has candidates). */
	perLayerMin?: number;
}

export type MemoryLayer = "project" | "global";

export interface RetrievedMemoryEntry {
	layer: MemoryLayer;
	entry: MemoryIndexEntry;
	content: string;
	/** The slice actually rendered into the prelude (matched sections or a bounded head). */
	excerpt: string;
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
	indexPath: string;
	index: MemoryIndex;
}

const DEFAULT_MEMORY_ROOT = ".minimum";
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_PER_LAYER_MIN = 1;
/** How many metadata-qualified candidates we read content for, relative to maxResults. */
const CONTENT_READ_FACTOR = 4;
/** Upper bound on a single full-content fallback excerpt, so one big file can't dominate. */
const FALLBACK_EXCERPT_CHARS = 800;
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
 * Recall is deterministic and cheap. Scoring runs in two passes:
 *  1. Metadata pre-filter — score every index entry on key/tags/scope/headings/
 *     relatedFiles WITHOUT reading the file. Entries with no signal are dropped.
 *  2. Lazy content read — only the top metadata candidates have their markdown
 *     read (cached by mtime) for a refined score and a section-level excerpt.
 *
 * Selection then applies a per-layer minimum so the hierarchy is preserved, and
 * a token budget so the prelude stays bounded.
 */
export class MemoryRetriever {
	private readonly projectRoot: string;
	private readonly memoryRoot: string;
	private readonly globalMemoryRoot: string;
	private readonly maxResults: number;
	private readonly maxTokens: number;
	private readonly perLayerMin: number;
	/** mtime-keyed caches so unchanged indexes/files are not re-read across turns. */
	private readonly indexCache = new Map<string, { mtimeMs: number; index: MemoryIndex }>();
	private readonly contentCache = new Map<string, { mtimeMs: number; content: string }>();

	constructor(options: MemoryRetrieverOptions = {}) {
		this.projectRoot = options.projectRoot ?? process.cwd();
		this.memoryRoot = options.memoryRoot ?? DEFAULT_MEMORY_ROOT;
		this.globalMemoryRoot = options.globalMemoryRoot ?? path.join(resolveHome(), DEFAULT_MEMORY_ROOT);
		this.maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
		this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
		this.perLayerMin = options.perLayerMin ?? DEFAULT_PER_LAYER_MIN;
	}

	async retrieveMemory(query: string | RetrieveMemoryQuery): Promise<RetrievedMemory> {
		const normalized = normalizeQuery(query);
		const keywords = extractKeywords(normalized.input);
		const recentFiles = extractRecentFiles(normalized.messages ?? [], normalized.input);
		const maxResults = normalized.maxResults ?? this.maxResults;

		const layers = await this.readIndexes();

		// Pass 1: metadata-only pre-filter. No file content is read here.
		const candidates: Array<{
			layer: MemoryLayer;
			root: string;
			entry: MemoryIndexEntry;
			metaScore: number;
			matched: RetrievedMemoryEntry["matched"];
		}> = [];
		for (const indexed of layers) {
			for (const entry of indexed.index.entries) {
				if (!entry.exists) continue;
				const meta = scoreMetadata(indexed.layer, entry, keywords, recentFiles);
				if (meta.score <= 0) continue;
				candidates.push({ layer: indexed.layer, root: indexed.root, entry, metaScore: meta.score, matched: meta.matched });
			}
		}

		// Read content only for the strongest metadata candidates.
		candidates.sort((a, b) => b.metaScore - a.metaScore);
		const readLimit = Math.max(maxResults * CONTENT_READ_FACTOR, maxResults);
		const toRead = candidates.slice(0, readLimit);

		// Pass 2: lazy content read + refined score + excerpt.
		const scored: RetrievedMemoryEntry[] = [];
		for (const cand of toRead) {
			const content = await this.readContent(cand.root, cand.entry);
			const contentHits = scoreContent(content, keywords);
			const matched = mergeMatched(cand.matched, contentHits.matched);
			const score =
				cand.metaScore +
				contentHits.score +
				layerBoost(cand.layer) +
				confidenceBoost(cand.entry) +
				recencyBoost(cand.entry.mtimeMs);
			scored.push({
				layer: cand.layer,
				entry: cand.entry,
				content,
				excerpt: buildExcerpt(content, keywords),
				score,
				matched,
			});
		}

		scored.sort(compareResults);
		const selected = selectWithLayerQuota(scored, maxResults, this.perLayerMin);
		const entries = applyTokenBudget(selected, this.maxTokens);
		return {
			prelude: renderPrelude(entries),
			entries,
			keywords,
			recentFiles,
		};
	}

	private async readIndexes(): Promise<IndexedLayer[]> {
		const projectIndexPath = path.join(this.projectRoot, this.memoryRoot, "index.json");
		const globalIndexPath = path.join(this.globalMemoryRoot, "index.json");
		const projectIndex = await this.readIndex(projectIndexPath);
		const globalIndex = await this.readIndex(globalIndexPath);
		const layers: IndexedLayer[] = [];
		if (projectIndex) layers.push({ layer: "project", root: this.projectRoot, indexPath: projectIndexPath, index: projectIndex });
		if (globalIndex) layers.push({ layer: "global", root: path.dirname(this.globalMemoryRoot), indexPath: globalIndexPath, index: globalIndex });
		return layers;
	}

	private async readIndex(filePath: string): Promise<MemoryIndex | null> {
		let mtimeMs: number;
		try {
			mtimeMs = (await fs.stat(filePath)).mtimeMs;
		} catch {
			this.indexCache.delete(filePath);
			return null;
		}
		const cached = this.indexCache.get(filePath);
		if (cached && cached.mtimeMs === mtimeMs) return cached.index;
		try {
			const index = JSON.parse(await fs.readFile(filePath, "utf-8")) as MemoryIndex;
			this.indexCache.set(filePath, { mtimeMs, index });
			return index;
		} catch {
			this.indexCache.delete(filePath);
			return null;
		}
	}

	private async readContent(root: string, entry: MemoryIndexEntry): Promise<string> {
		const filePath = path.join(root, entry.path);
		const cached = this.contentCache.get(filePath);
		if (cached && entry.mtimeMs && cached.mtimeMs === entry.mtimeMs) return cached.content;
		try {
			const content = await fs.readFile(filePath, "utf-8");
			if (entry.mtimeMs) this.contentCache.set(filePath, { mtimeMs: entry.mtimeMs, content });
			return content;
		} catch {
			return "";
		}
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

/** Score an entry from index metadata only — no file content is read. */
function scoreMetadata(
	layer: MemoryLayer,
	entry: MemoryIndexEntry,
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

	void layer;
	return {
		score,
		matched: {
			keywords: [...matchedKeywords].sort(),
			relatedFiles: [...matchedFiles].sort(),
			fields: [...matchedFields].sort(),
		},
	};
}

/** Additional score from keyword hits in the (lazily read) file body. */
function scoreContent(content: string, keywords: string[]): Pick<RetrievedMemoryEntry, "score" | "matched"> {
	let score = 0;
	const matchedKeywords = new Set<string>();
	const matchedFields = new Set<string>();
	if (content) {
		for (const keyword of keywords) {
			if (containsNeedle(content, keyword)) {
				matchedKeywords.add(keyword);
				matchedFields.add("content");
				score += fieldWeight("content");
			}
		}
	}
	return {
		score,
		matched: { keywords: [...matchedKeywords].sort(), relatedFiles: [], fields: [...matchedFields].sort() },
	};
}

function mergeMatched(
	a: RetrievedMemoryEntry["matched"],
	b: RetrievedMemoryEntry["matched"],
): RetrievedMemoryEntry["matched"] {
	return {
		keywords: [...new Set([...a.keywords, ...b.keywords])].sort(),
		relatedFiles: [...new Set([...a.relatedFiles, ...b.relatedFiles])].sort(),
		fields: [...new Set([...a.fields, ...b.fields])].sort(),
	};
}

/**
 * Excerpt the content for the prelude: the markdown sections whose heading or
 * body matched a keyword, or — when the match came only from metadata
 * (relatedFiles/tags) — a bounded head of the file.
 */
function buildExcerpt(content: string, keywords: string[]): string {
	const trimmed = content.trim();
	if (!trimmed) return "";
	if (keywords.length === 0) return clampChars(trimmed, FALLBACK_EXCERPT_CHARS);

	const sections = splitSections(trimmed);
	const matched = sections.filter((section) =>
		keywords.some((keyword) => containsNeedle(section.text, keyword)),
	);
	if (matched.length === 0) return clampChars(trimmed, FALLBACK_EXCERPT_CHARS);
	return matched.map((section) => section.text.trim()).join("\n\n");
}

interface MarkdownSection {
	heading: string;
	text: string;
}

/** Split markdown into sections at each ATX heading; preamble before the first heading is its own section. */
function splitSections(text: string): MarkdownSection[] {
	const lines = text.split(/\r?\n/);
	const sections: MarkdownSection[] = [];
	let heading = "";
	let buffer: string[] = [];
	const flush = () => {
		if (buffer.length === 0) return;
		const body = buffer.join("\n").trim();
		if (body) sections.push({ heading, text: buffer.join("\n") });
		buffer = [];
	};
	for (const line of lines) {
		if (/^#{1,6}\s+/.test(line)) {
			flush();
			heading = line.replace(/^#{1,6}\s+/, "").trim();
		}
		buffer.push(line);
	}
	flush();
	return sections;
}

function clampChars(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Pick up to maxResults entries, guaranteeing each present layer at least perLayerMin. */
function selectWithLayerQuota(
	scored: RetrievedMemoryEntry[],
	maxResults: number,
	perLayerMin: number,
): RetrievedMemoryEntry[] {
	if (scored.length <= maxResults) return scored.slice(0, maxResults);
	const chosen = new Set<RetrievedMemoryEntry>();

	if (perLayerMin > 0) {
		const byLayer = new Map<MemoryLayer, RetrievedMemoryEntry[]>();
		for (const entry of scored) {
			const list = byLayer.get(entry.layer) ?? [];
			list.push(entry);
			byLayer.set(entry.layer, list);
		}
		for (const list of byLayer.values()) {
			for (const entry of list.slice(0, perLayerMin)) {
				if (chosen.size >= maxResults) break;
				chosen.add(entry);
			}
		}
	}

	for (const entry of scored) {
		if (chosen.size >= maxResults) break;
		chosen.add(entry);
	}
	// Preserve global ranking order in the output.
	return scored.filter((entry) => chosen.has(entry));
}

/** Keep entries in ranked order until the cumulative excerpt token budget is hit (always keep the first). */
function applyTokenBudget(entries: RetrievedMemoryEntry[], maxTokens: number): RetrievedMemoryEntry[] {
	if (entries.length === 0 || maxTokens <= 0) return entries;
	const kept: RetrievedMemoryEntry[] = [];
	let used = 0;
	for (const entry of entries) {
		const cost = estimateTokens(entry.excerpt || entry.content);
		if (kept.length > 0 && used + cost > maxTokens) break;
		kept.push(entry);
		used += cost;
	}
	return kept;
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
		const body = (result.excerpt || result.content).trim() || result.entry.headings.map((heading) => `- ${heading}`).join("\n");
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

function layerBoost(layer: MemoryLayer): number {
	return layer === "project" ? 8 : 0;
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
