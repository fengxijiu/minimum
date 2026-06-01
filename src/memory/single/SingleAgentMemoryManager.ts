import * as path from "node:path";
import type { ChatMessage } from "../../types/common.js";
import { MemoryStore, type MemoryEntry } from "../MemoryStore.js";
import { ProjectMemory, type ProjectMemoryEntry } from "../ProjectMemory.js";

export type MemoryScope = "project" | "global";

export interface SingleAgentMemoryManagerOptions {
	projectRoot: string;
	globalBasePath?: string;
	maxPreludeEntries?: number;
	maxStoredEntries?: number;
	projectMemoryFactory?: (projectRoot: string) => ProjectMemory;
	globalStore?: MemoryStore;
}

export interface MemoryManagerRequest {
	projectRoot?: string;
	input?: string;
	messages?: ChatMessage[];
}

export interface MemoryCandidate {
	scope: MemoryScope;
	key: string;
	value: string;
	description?: string;
	updatedAt: number;
	metadata?: Record<string, unknown>;
}

export interface ScoredMemory extends MemoryCandidate {
	score: number;
	reason: string;
}

export interface ExtractedMemory {
	scope: MemoryScope;
	key: string;
	value: string;
	description?: string;
	metadata?: Record<string, unknown>;
}

export interface MemoryInjectionResult {
	injected: boolean;
	prelude: string;
	entries: ScoredMemory[];
}

export interface MemoryWritebackResult {
	projectWritten: number;
	globalWritten: number;
	compacted: number;
	entries: ExtractedMemory[];
}

interface MemoryStores {
	project: ProjectMemory;
	global: MemoryStore;
}

export class MemoryRetriever {
	async retrieve(stores: MemoryStores): Promise<MemoryCandidate[]> {
		const [projectEntries, globalEntries] = await Promise.all([
			stores.project.list(),
			stores.global.list("user"),
		]);

		return [
			...projectEntries.map((entry) => this.fromProjectEntry(entry)),
			...globalEntries.map((entry) => this.fromGlobalEntry(entry)),
		];
	}

	private fromProjectEntry(entry: ProjectMemoryEntry): MemoryCandidate {
		return {
			scope: "project",
			key: entry.key,
			value: entry.value,
			description: entry.description,
			updatedAt: entry.updatedAt,
		};
	}

	private fromGlobalEntry(entry: MemoryEntry): MemoryCandidate {
		return {
			scope: "global",
			key: entry.key,
			value: entry.value,
			updatedAt: entry.timestamp,
			metadata: entry.metadata,
		};
	}
}

export class SingleAgentMemoryScorer {
	score(input: string, memory: MemoryCandidate): ScoredMemory {
		const terms = tokenize(input);
		const haystack = tokenize(
			`${memory.key} ${memory.value} ${memory.description ?? ""}`,
		);
		const overlap = terms.filter((term) => haystack.includes(term));
		const exact = input.toLowerCase().includes(memory.key.toLowerCase())
			? 0.4
			: 0;
		const recency = Math.max(
			0,
			0.05 - (Date.now() - memory.updatedAt) / 86_400_000 / 200,
		);
		const scopeBoost = memory.scope === "global" ? 0.02 : 0.03;
		const score = Math.min(
			1,
			overlap.length / Math.max(terms.length, 1) +
				exact +
				recency +
				scopeBoost,
		);
		const reason =
			overlap.length > 0
				? `matched: ${overlap.slice(0, 5).join(", ")}`
				: "scope/recency boost";
		return {
			...memory,
			score,
			reason,
		};
	}
}

export class MemoryResolver {
	constructor(
		private scorer = new SingleAgentMemoryScorer(),
		private minScore = 0.12,
	) {}

	resolve(
		input: string,
		candidates: MemoryCandidate[],
		limit: number,
	): ScoredMemory[] {
		return candidates
			.map((candidate) => this.scorer.score(input, candidate))
			.filter((memory) => memory.score >= this.minScore)
			.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
			.slice(0, limit);
	}
}

export class MemoryPreludeBuilder {
	build(entries: ScoredMemory[]): string {
		if (entries.length === 0) return "";
		const lines = entries.map((entry) => {
			const prefix = entry.scope === "global" ? "Global" : "Project";
			return `- ${prefix} memory (${entry.key}): ${entry.value}`;
		});
		return [
			"Relevant long-term memory for this turn:",
			...lines,
			"Use these memories when they are relevant, but do not mention them unless useful.",
		].join("\n");
	}
}

export class MemoryExtractor {
	extract(request: MemoryManagerRequest): ExtractedMemory[] {
		const text = this.getText(request);
		if (!text.trim()) return [];

		const extracted: ExtractedMemory[] = [];
		for (const sentence of splitSentences(text)) {
			if (!isMemorySentence(sentence)) continue;
			const scope = inferScope(sentence);
			const value = normalizeMemoryValue(sentence);
			if (value.length < 4) continue;
			extracted.push({
				scope,
				key: makeKey(value, scope),
				value,
				description: `Extracted ${scope} memory`,
				metadata: { extractedAt: Date.now() },
			});
		}

		return dedupeExtracted(extracted);
	}

	private getText(request: MemoryManagerRequest): string {
		if (request.input) return request.input;
		return (request.messages ?? [])
			.filter(
				(message) => message.role === "user" || message.role === "assistant",
			)
			.map((message) => message.content)
			.join("\n");
	}
}

export class MemoryWriter {
	async write(
		stores: MemoryStores,
		entries: ExtractedMemory[],
	): Promise<{ projectWritten: number; globalWritten: number }> {
		let projectWritten = 0;
		let globalWritten = 0;
		for (const entry of entries) {
			if (entry.scope === "global") {
				await stores.global.set({
					key: entry.key,
					value: entry.value,
					type: "user",
					timestamp: Date.now(),
					metadata: entry.metadata,
				});
				globalWritten++;
			} else {
				await stores.project.set(entry.key, entry.value, entry.description);
				projectWritten++;
			}
		}
		return { projectWritten, globalWritten };
	}
}

export class MemoryCompactor {
	constructor(private maxStoredEntries = 200) {}

	async compact(stores: MemoryStores): Promise<number> {
		const [projectEntries, globalEntries] = await Promise.all([
			stores.project.list(),
			stores.global.list("user"),
		]);
		let compacted = 0;
		for (const entry of projectEntries
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(this.maxStoredEntries)) {
			if (await stores.project.delete(entry.key)) compacted++;
		}
		for (const entry of globalEntries
			.sort((a, b) => b.timestamp - a.timestamp)
			.slice(this.maxStoredEntries)) {
			if (await stores.global.delete(entry.key)) compacted++;
		}
		return compacted;
	}
}

export class SingleAgentMemoryManager {
	private globalStore: MemoryStore;
	private projectMemories = new Map<string, ProjectMemory>();
	private initializedGlobal?: Promise<void>;
	private maxPreludeEntries: number;
	readonly retriever: MemoryRetriever;
	readonly resolver: MemoryResolver;
	readonly preludeBuilder: MemoryPreludeBuilder;
	readonly extractor: MemoryExtractor;
	readonly scorer: SingleAgentMemoryScorer;
	readonly writer: MemoryWriter;
	readonly compactor: MemoryCompactor;

	constructor(private options: SingleAgentMemoryManagerOptions) {
		this.globalStore =
			options.globalStore ??
			new MemoryStore({ basePath: options.globalBasePath });
		this.maxPreludeEntries = options.maxPreludeEntries ?? 8;
		this.scorer = new SingleAgentMemoryScorer();
		this.retriever = new MemoryRetriever();
		this.resolver = new MemoryResolver(this.scorer);
		this.preludeBuilder = new MemoryPreludeBuilder();
		this.extractor = new MemoryExtractor();
		this.writer = new MemoryWriter();
		this.compactor = new MemoryCompactor(options.maxStoredEntries ?? 200);
	}

	async buildPrelude(request: MemoryManagerRequest): Promise<MemoryInjectionResult> {
		const input =
			request.input ??
			request.messages?.map((message) => message.content).join("\n") ??
			"";
		const stores = await this.getStores(request.projectRoot);
		const candidates = await this.retriever.retrieve(stores);
		const entries = this.resolver.resolve(input, candidates, this.maxPreludeEntries);
		const prelude = this.preludeBuilder.build(entries);
		return { injected: prelude.length > 0, prelude, entries };
	}

	async writeback(request: MemoryManagerRequest): Promise<MemoryWritebackResult> {
		const stores = await this.getStores(request.projectRoot);
		const entries = this.extractor.extract(request);
		const written = await this.writer.write(stores, entries);
		const compacted = await this.compactor.compact(stores);
		return { ...written, compacted, entries };
	}

	private async getStores(
		projectRoot = this.options.projectRoot,
	): Promise<MemoryStores> {
		await this.ensureGlobalInitialized();
		const normalizedRoot = path.resolve(projectRoot || this.options.projectRoot);
		let project = this.projectMemories.get(normalizedRoot);
		if (!project) {
			project =
				this.options.projectMemoryFactory?.(normalizedRoot) ??
				new ProjectMemory(normalizedRoot);
			await project.initialize();
			this.projectMemories.set(normalizedRoot, project);
		}
		return { project, global: this.globalStore };
	}

	private ensureGlobalInitialized(): Promise<void> {
		this.initializedGlobal ??= this.globalStore.initialize();
		return this.initializedGlobal;
	}
}

function tokenize(value: string): string[] {
	return Array.from(
		new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []),
	);
}

function splitSentences(value: string): string[] {
	return value
		.split(/[\n。.!?]+/u)
		.map((part) => part.trim())
		.filter(Boolean);
}

function isMemorySentence(value: string): boolean {
	return (
		/\b(remember|memory|preference|prefer|always)\b/i.test(value) ||
		/(记住|记忆|偏好|项目约定|全局)/u.test(value)
	);
}

function inferScope(value: string): MemoryScope {
	return /\b(global|globally|all projects|cross-project)\b/i.test(value) ||
		/(全局|跨项目)/u.test(value)
		? "global"
		: "project";
}

function normalizeMemoryValue(value: string): string {
	return value
		.replace(/^\s*(please\s+)?(remember|memorize)\s+(that\s+)?/i, "")
		.replace(/^\s*(记住|请记住|记忆)[:：]?\s*/u, "")
		.replace(
			/\b(for this project|as project memory|project memory|globally|as global memory|global memory)\b[:：]?/gi,
			"",
		)
		.replace(/(作为项目记忆|项目记忆|作为全局记忆|全局记忆|跨项目)[:：]?/gu, "")
		.trim();
}

function makeKey(value: string, scope: MemoryScope): string {
	const slug =
		(value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
			.slice(0, 8)
			.join("-")
			.replace(/^-+|-+$/g, "") || "memory";
	return `${scope}:${slug}`.slice(0, 96);
}

function dedupeExtracted(entries: ExtractedMemory[]): ExtractedMemory[] {
	const seen = new Set<string>();
	return entries.filter((entry) => {
		const id = `${entry.scope}:${entry.key}:${entry.value}`;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}
