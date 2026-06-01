import * as fs from "node:fs/promises";
import * as path from "node:path";
import { estimateTokens } from "../../utils/token-counter.js";
import { buildMemoryIndex, writeMemoryIndex } from "../governance/MemoryIndex.js";
import { defaultManifest, getOrInitManifest } from "../governance/MemoryManifest.js";
import type { Manifest, MemoryConfidence } from "../governance/types.js";

export interface MemoryCompactorOptions {
	memoryRoot?: string;
	/** Trigger deep compaction when any indexed memory file is at least this size. */
	maxFileBytes?: number;
	/** Trigger deep compaction when parsed record count reaches this value. */
	maxRecords?: number;
	/** Trigger deep compaction when total estimated tokens reach this value. */
	maxTotalTokens?: number;
	/** Trigger deep compaction when recorded prelude truncations reach this value. */
	maxPreludeTruncations?: number;
	/** Similarity threshold for lightweight content merging. Defaults to 0.82. */
	similarityThreshold?: number;
	/** Injectable clock for deterministic archive paths. */
	now?: Date;
}

export interface DeepCompressionDecision {
	shouldCompress: boolean;
	reasons: string[];
	metrics: CompressionMetrics;
}

export interface CompressionMetrics {
	fileBytes: number;
	records: number;
	totalTokens: number;
	preludeTruncations: number;
}

export interface CompressionReport {
	lightMerged: number;
	deepCompressed: boolean;
	compressedPath?: string;
	archivedPaths: string[];
	indexPath: string;
	decision: DeepCompressionDecision;
}

interface MemoryRecord {
	id: string;
	filePath: string;
	line: string;
	key: string;
	content: string;
	relatedFiles: string[];
	sourceSessionIds: string[];
	confidence: MemoryConfidence;
	lastVerified: string;
	provenanceRaw: string[];
	archivable: boolean;
}

interface FileRecords {
	filePath: string;
	text: string;
	records: MemoryRecord[];
}

const DEFAULT_OPTIONS: Required<Pick<MemoryCompactorOptions,
	"maxFileBytes" | "maxRecords" | "maxTotalTokens" | "maxPreludeTruncations" | "similarityThreshold"
>> = {
	maxFileBytes: 256 * 1024,
	maxRecords: 400,
	maxTotalTokens: 32_000,
	maxPreludeTruncations: 3,
	similarityThreshold: 0.82,
};

const CONFIDENCE_RANK: Record<MemoryConfidence, number> = { low: 0, medium: 1, high: 2 };

/**
 * MemoryCompactor performs bounded local compaction for the single-project
 * memory directory. Lightweight compaction rewrites duplicate facts in-place;
 * deep compaction emits `.minimum/compressed.md`, archives low-value old source
 * files, and refreshes `.minimum/index.json` so archived records disappear from
 * normal recall.
 */
export class MemoryCompactor {
	constructor(private readonly projectRoot: string, private readonly opts: MemoryCompactorOptions = {}) {}

	async compact(): Promise<CompressionReport> {
		const manifest = await this.manifest();
		const files = await this.loadFiles(manifest);
		const lightMerged = await this.lightCompact(files);
		const refreshedFiles = await this.loadFiles(manifest);
		const decision = await this.decideDeepCompact(refreshedFiles);

		let compressedPath: string | undefined;
		let archivedPaths: string[] = [];
		if (decision.shouldCompress) {
			const deep = await this.deepCompact(refreshedFiles, manifest);
			compressedPath = deep.compressedPath;
			archivedPaths = deep.archivedPaths;
		}

		const index = await buildMemoryIndex(this.projectRoot, manifest);
		const indexPath = await writeMemoryIndex(this.projectRoot, index);
		return {
			lightMerged,
			deepCompressed: decision.shouldCompress,
			...(compressedPath && { compressedPath }),
			archivedPaths,
			indexPath,
			decision,
		};
	}

	async shouldDeepCompact(): Promise<DeepCompressionDecision> {
		return this.decideDeepCompact(await this.loadFiles(await this.manifest()));
	}

	private async decideDeepCompact(loaded: FileRecords[]): Promise<DeepCompressionDecision> {
		const metrics = await this.metrics(loaded);
		const reasons: string[] = [];
		const maxFileBytes = this.opts.maxFileBytes ?? DEFAULT_OPTIONS.maxFileBytes;
		const maxRecords = this.opts.maxRecords ?? DEFAULT_OPTIONS.maxRecords;
		const maxTotalTokens = this.opts.maxTotalTokens ?? DEFAULT_OPTIONS.maxTotalTokens;
		const maxPreludeTruncations = this.opts.maxPreludeTruncations ?? DEFAULT_OPTIONS.maxPreludeTruncations;

		if (metrics.fileBytes >= maxFileBytes) reasons.push(`file_size:${metrics.fileBytes}`);
		if (metrics.records >= maxRecords) reasons.push(`records:${metrics.records}`);
		if (metrics.totalTokens >= maxTotalTokens) reasons.push(`tokens:${metrics.totalTokens}`);
		if (metrics.preludeTruncations >= maxPreludeTruncations) {
			reasons.push(`prelude_truncations:${metrics.preludeTruncations}`);
		}
		return { shouldCompress: reasons.length > 0, reasons, metrics };
	}

	private async manifest(): Promise<Manifest> {
		if (!this.opts.memoryRoot) return getOrInitManifest(this.projectRoot);
		try {
			return await getOrInitManifest(this.projectRoot, this.opts.memoryRoot);
		} catch {
			return defaultManifest(this.opts.memoryRoot);
		}
	}

	private async loadFiles(manifest: Manifest): Promise<FileRecords[]> {
		const files = await this.memoryMarkdownFiles(manifest);
		const out: FileRecords[] = [];
		for (const filePath of files) {
			const text = await fs.readFile(filePath, "utf-8");
			out.push({ filePath, text, records: parseRecords(filePath, text) });
		}
		return out;
	}

	private async memoryMarkdownFiles(manifest: Manifest): Promise<string[]> {
		const root = path.join(this.projectRoot, manifest.memoryRoot);
		const canonical = new Set(Object.values(manifest.canonicalFiles).map((rel) => path.join(this.projectRoot, rel)));
		const found: string[] = [];
		async function walk(dir: string): Promise<void> {
			let entries: Array<import("node:fs").Dirent>;
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (entry.name.startsWith("_") || entry.name === "tasks") continue;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) await walk(full);
				else if (entry.isFile() && entry.name.endsWith(".md")) found.push(full);
			}
		}
		await walk(root);
		for (const filePath of canonical) {
			try {
				const stat = await fs.stat(filePath);
				if (stat.isFile()) found.push(filePath);
			} catch {
				// Missing canonical files do not need compaction.
			}
		}
		return [...new Set(found)].sort();
	}

	private async lightCompact(files: FileRecords[]): Promise<number> {
		let merged = 0;
		for (const file of files) {
			let fileMerged = 0;
			if (file.records.length < 2) continue;
			const keep = new Set(file.records.map((record) => record.id));
			const mergedById = new Map(file.records.map((record) => [record.id, record]));
			for (let i = 0; i < file.records.length; i++) {
				let a = mergedById.get(file.records[i]!.id)!;
				if (!keep.has(a.id)) continue;
				for (let j = i + 1; j < file.records.length; j++) {
					const b = mergedById.get(file.records[j]!.id)!;
					if (!keep.has(b.id)) continue;
					if (!shouldMerge(a, b, this.opts.similarityThreshold ?? DEFAULT_OPTIONS.similarityThreshold)) continue;
					a = mergeRecords(a, b);
					mergedById.set(a.id, a);
					keep.delete(b.id);
					merged++;
					fileMerged++;
				}
			}
			if (fileMerged > 0) {
				const compacted = file.records
					.filter((record) => keep.has(record.id))
					.map((record) => renderRecord(mergedById.get(record.id)!))
					.join("\n");
				await fs.writeFile(file.filePath, `${compacted.trim()}\n`, "utf-8");
			}
		}
		return merged;
	}

	private async deepCompact(files: FileRecords[], manifest: Manifest): Promise<{ compressedPath: string; archivedPaths: string[] }> {
		const allRecords = files.flatMap((file) => file.records);
		const lowValueFiles = files.filter((file) => file.records.length > 0 && file.records.every((record) => record.archivable));
		const compressedPath = path.join(this.projectRoot, manifest.memoryRoot, "compressed.md");
		await fs.mkdir(path.dirname(compressedPath), { recursive: true });
		await fs.writeFile(compressedPath, renderCompressed(allRecords), "utf-8");

		const ym = archiveMonth(this.opts.now ?? new Date());
		const archiveDir = path.join(this.projectRoot, manifest.memoryRoot, "_archive", ym);
		await fs.mkdir(archiveDir, { recursive: true });
		const archivedPaths: string[] = [];
		for (const file of lowValueFiles) {
			if (path.basename(file.filePath) === "compressed.md") continue;
			const dest = path.join(archiveDir, path.basename(file.filePath));
			await fs.rename(file.filePath, dest);
			archivedPaths.push(dest);
		}
		return { compressedPath, archivedPaths };
	}

	private async metrics(files: FileRecords[]): Promise<CompressionMetrics> {
		let fileBytes = 0;
		let records = 0;
		let totalTokens = 0;
		let preludeTruncations = 0;
		for (const file of files) {
			const stat = await fs.stat(file.filePath);
			fileBytes = Math.max(fileBytes, stat.size);
			records += file.records.length;
			totalTokens += estimateTokens(file.text);
			preludeTruncations += countPreludeTruncations(file.text);
		}
		return { fileBytes, records, totalTokens, preludeTruncations };
	}
}

function parseRecords(filePath: string, text: string): MemoryRecord[] {
	const lines = text.split(/\r?\n/);
	const records: MemoryRecord[] = [];
	let provenance: Partial<MemoryRecord> | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const parsedProvenance = parseProvenance(line);
		if (parsedProvenance) {
			provenance = parsedProvenance;
			continue;
		}
		if (!/^\s*[-*]\s+/.test(line)) continue;
		const content = line.replace(/^\s*[-*]\s+/, "").trim();
		const key = recordKey(content);
		const confidence = provenance?.confidence ?? confidenceFromText(content);
		records.push({
			id: `${filePath}:${i}`,
			filePath,
			line,
			key,
			content,
			relatedFiles: provenance?.relatedFiles ?? extractInlineList(content, "relatedFiles"),
			sourceSessionIds: provenance?.sourceSessionIds ?? extractInlineList(content, "sourceSession"),
			confidence,
			lastVerified: provenance?.lastVerified ?? new Date(0).toISOString(),
			provenanceRaw: provenance?.provenanceRaw ?? [],
			archivable: confidence === "low" || /\b(low value|deprecated|obsolete|stale)\b/i.test(content),
		});
		provenance = null;
	}
	return records;
}

function parseProvenance(line: string): Partial<MemoryRecord> | null {
	const m = line.match(/<!--\s*mimo-memory\s+(.+?)\s*-->/);
	if (!m) return null;
	const raw = m[1]!;
	const fields = Object.fromEntries(
		[...raw.matchAll(/([a-zA-Z_]+)=([\s\S]*?)(?=\s+[a-zA-Z_]+=|$)/g)].map((match) => [
			match[1]!,
			match[2]!.trim().replace(/^"|"$/g, ""),
		]),
	);
	const confidence: MemoryConfidence = fields.confidence && isConfidence(fields.confidence) ? fields.confidence : "medium";
	return {
		relatedFiles: splitList(fields.related_files ?? fields.relatedFiles ?? ""),
		sourceSessionIds: splitList(fields.source_session_id ?? fields.source_task ?? fields.session_id ?? ""),
		confidence,
		lastVerified: fields.last_verified ?? fields.lastVerified ?? new Date(0).toISOString(),
		provenanceRaw: [line.trim()],
	};
}

function shouldMerge(a: MemoryRecord, b: MemoryRecord, threshold: number): boolean {
	if (a.key && a.key === b.key) return true;
	if (sameRelatedFiles(a, b) && normalizeFact(a.content) === normalizeFact(b.content)) return true;
	return jaccardSimilarity(a.content, b.content) >= threshold;
}

function mergeRecords(a: MemoryRecord, b: MemoryRecord): MemoryRecord {
	return {
		...a,
		content: a.content.length >= b.content.length ? a.content : b.content,
		relatedFiles: uniq([...a.relatedFiles, ...b.relatedFiles]),
		sourceSessionIds: uniq([...a.sourceSessionIds, ...b.sourceSessionIds]),
		confidence: CONFIDENCE_RANK[a.confidence] >= CONFIDENCE_RANK[b.confidence] ? a.confidence : b.confidence,
		lastVerified: maxIso(a.lastVerified, b.lastVerified),
		provenanceRaw: uniq([...a.provenanceRaw, ...b.provenanceRaw]),
		archivable: a.archivable && b.archivable,
	};
}

function renderRecord(record: MemoryRecord): string {
	const provenance = `<!-- mimo-memory source_session_id=${record.sourceSessionIds.join(",")} related_files=${record.relatedFiles.join(",")} confidence=${record.confidence} last_verified=${record.lastVerified} -->`;
	return `${provenance}\n- ${record.content.trim()}\n`;
}

function renderCompressed(records: MemoryRecord[]): string {
	const rendered = records.map(renderRecord).join("\n").trim();
	return `# Compressed Memory\n\n${rendered}\n`;
}

function recordKey(content: string): string {
	const stripped = content.replace(/^\*\*(.+?)\*\*\s*:?\s*/, "$1: ");
	const m = stripped.match(/^([^:：]{2,80})[:：]/);
	return m ? normalizeFact(m[1]!) : "";
}

function normalizeFact(content: string): string {
	return content.toLowerCase().replace(/[`*_#[\](){}.,;:!?]/g, " ").replace(/\s+/g, " ").trim();
}

function jaccardSimilarity(a: string, b: string): number {
	const aTokens = new Set(normalizeFact(a).split(" ").filter(Boolean));
	const bTokens = new Set(normalizeFact(b).split(" ").filter(Boolean));
	if (aTokens.size === 0 || bTokens.size === 0) return 0;
	let overlap = 0;
	for (const token of aTokens) if (bTokens.has(token)) overlap++;
	return overlap / (aTokens.size + bTokens.size - overlap);
}

function sameRelatedFiles(a: MemoryRecord, b: MemoryRecord): boolean {
	return a.relatedFiles.length > 0 && a.relatedFiles.sort().join("\0") === b.relatedFiles.sort().join("\0");
}

function countPreludeTruncations(text: string): number {
	return (text.match(/prelude[_ -]?truncat(?:ed|ion)/gi) ?? []).length;
}

function extractInlineList(text: string, key: string): string[] {
	const m = text.match(new RegExp(`${key}=\\[([^\\]]*)\\]`, "i"));
	return m ? splitList(m[1]!) : [];
}

function splitList(value: string): string[] {
	return value.split(/[,|]/).map((item) => item.trim()).filter(Boolean);
}

function confidenceFromText(text: string): MemoryConfidence {
	const m = text.match(/confidence=(high|medium|low)/i);
	return m && isConfidence(m[1]) ? m[1].toLowerCase() as MemoryConfidence : "medium";
}

function isConfidence(value: unknown): value is MemoryConfidence {
	return value === "high" || value === "medium" || value === "low";
}

function maxIso(a: string, b: string): string {
	return Date.parse(a) >= Date.parse(b) ? a : b;
}

function uniq(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function archiveMonth(now: Date): string {
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
