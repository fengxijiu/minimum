import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getOrInitManifest } from "./MemoryManifest.js";
import { listCandidates } from "./MemoryStaging.js";
import type { Manifest } from "./types.js";

export type MemoryIndexKind =
	| "canonical"
	| "staging"
	| "context_pack"
	| "pipeline_artifact";

export interface MemoryIndexEntry {
	kind: MemoryIndexKind;
	key?: string;
	id?: string;
	path: string;
	exists: boolean;
	bytes: number;
	mtimeMs: number;
	headings: string[];
	tags: string[];
	scope?: string;
	relatedFiles: string[];
}

export interface MemoryIndex {
	version: number;
	generatedAt: string;
	memoryRoot: string;
	entries: MemoryIndexEntry[];
}

export async function buildMemoryIndex(
	projectRoot: string,
	manifest?: Manifest,
): Promise<MemoryIndex> {
	const m = manifest ?? (await getOrInitManifest(projectRoot));
	const entries: MemoryIndexEntry[] = [];

	for (const [key, rel] of Object.entries(m.canonicalFiles)) {
		entries.push(await indexFile(projectRoot, rel, {
			kind: "canonical",
			key,
			tags: ["canonical", key],
		}));
	}

	const candidates = await listCandidates(projectRoot, m.memoryRoot);
	for (const candidate of candidates) {
		if (!candidate.sourcePath) continue;
		entries.push(await indexFile(projectRoot, candidate.sourcePath, {
			kind: "staging",
			id: `${candidate.sourceTask}.${candidate.persona}`,
			tags: ["staging", candidate.persona, candidate.confidence],
			scope: candidate.scope,
			relatedFiles: candidate.relatedFiles,
		}));
	}

	const taskRoot = path.join(projectRoot, m.memoryRoot, "tasks");
	for (const filePath of await listFiles(taskRoot)) {
		const rel = toRel(projectRoot, filePath);
		if (isContextPack(rel)) {
			entries.push(await indexFile(projectRoot, filePath, {
				kind: "context_pack",
				id: contextPackId(rel),
				tags: ["context_pack", ...taskPathTags(rel)],
			}));
			continue;
		}
		if (isPipelineArtifact(rel)) {
			entries.push(await indexFile(projectRoot, filePath, {
				kind: "pipeline_artifact",
				id: artifactId(rel),
				tags: ["pipeline_artifact", artifactTag(rel), ...taskPathTags(rel)],
			}));
		}
	}

	entries.sort((a, b) => a.path.localeCompare(b.path));
	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		memoryRoot: m.memoryRoot,
		entries,
	};
}

export async function writeMemoryIndex(
	projectRoot: string,
	index: MemoryIndex,
): Promise<string> {
	const filePath = memoryIndexPath(projectRoot, index.memoryRoot);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
	return filePath;
}

export async function readMemoryIndex(
	projectRoot: string,
	memoryRoot = ".minimum",
): Promise<MemoryIndex | null> {
	try {
		const text = await fs.readFile(memoryIndexPath(projectRoot, memoryRoot), "utf-8");
		return JSON.parse(text) as MemoryIndex;
	} catch {
		return null;
	}
}

export async function refreshMemoryIndex(
	projectRoot: string,
	manifest?: Manifest,
): Promise<string> {
	const index = await buildMemoryIndex(projectRoot, manifest);
	return writeMemoryIndex(projectRoot, index);
}

export function memoryIndexPath(projectRoot: string, memoryRoot = ".minimum"): string {
	return path.join(projectRoot, memoryRoot, "index.json");
}

async function indexFile(
	projectRoot: string,
	fileOrRel: string,
	meta: {
		kind: MemoryIndexKind;
		key?: string;
		id?: string;
		tags?: string[];
		scope?: string;
		relatedFiles?: string[];
	},
): Promise<MemoryIndexEntry> {
	const abs = path.isAbsolute(fileOrRel) ? fileOrRel : path.join(projectRoot, fileOrRel);
	const rel = toRel(projectRoot, abs);
	let exists = false;
	let bytes = 0;
	let mtimeMs = 0;
	let text = "";
	try {
		const stat = await fs.stat(abs);
		exists = true;
		bytes = stat.size;
		mtimeMs = stat.mtimeMs;
		if (isMarkdown(rel)) text = await fs.readFile(abs, "utf-8");
	} catch {
		exists = false;
	}
	return {
		kind: meta.kind,
		...(meta.key && { key: meta.key }),
		...(meta.id && { id: meta.id }),
		path: rel,
		exists,
		bytes,
		mtimeMs,
		headings: text ? extractHeadings(text) : [],
		tags: meta.tags ?? [],
		...(meta.scope && { scope: meta.scope }),
		relatedFiles: meta.relatedFiles ?? [],
	};
}

async function listFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Array<import("node:fs").Dirent>;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.isFile()) out.push(full);
		}
	}
	await walk(root);
	return out;
}

function extractHeadings(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.match(/^#{1,6}\s+(.+)$/)?.[1]?.trim())
		.filter((heading): heading is string => Boolean(heading));
}

function isMarkdown(rel: string): boolean {
	return rel.toLowerCase().endsWith(".md");
}

function isContextPack(rel: string): boolean {
	return /(^|\/)tasks\/[^/]+\/context-packs\/[^/]+\.md$/i.test(rel);
}

function isPipelineArtifact(rel: string): boolean {
	return /(^|\/)tasks\/[^/]+\/dag\.json$/i.test(rel) ||
		/(^|\/)tasks\/[^/]+\/(repair-dags|refinements|contracts|mission-checks)\/[^/]+\.(json|md)$/i.test(rel);
}

function artifactTag(rel: string): string {
	if (/\/dag\.json$/i.test(rel)) return "dag";
	if (/\/repair-dags\//i.test(rel)) return "repair_dag";
	if (/\/refinements\//i.test(rel)) return "refinement";
	if (/\/contracts\//i.test(rel)) return "contracts";
	if (/\/mission-checks\//i.test(rel)) return "mission_check";
	return "artifact";
}

function artifactId(rel: string): string {
	return rel.replace(/^.*?tasks\//, "").replace(/\.(json|md)$/i, "");
}

function contextPackId(rel: string): string {
	return rel.replace(/^.*?tasks\//, "").replace(/\/context-packs\//, ":").replace(/\.md$/i, "");
}

function taskPathTags(rel: string): string[] {
	const m = rel.match(/(^|\/)tasks\/([^/]+)/i);
	return m?.[2] ? [`epic:${m[2]}`] : [];
}

function toRel(projectRoot: string, filePath: string): string {
	return path.relative(projectRoot, filePath).replace(/\\/g, "/");
}
