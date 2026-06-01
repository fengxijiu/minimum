import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PersonaId } from "../../personas/Persona.js";
import type { MemoryCandidate, MemoryConfidence } from "./types.js";

/**
 * MemoryStaging — read/write the per-epic staging directory.
 *
 * The contract:
 *  - One file per (taskId, persona): `<taskId>.<persona>.memory.md`.
 *  - Frontmatter (--- delimited YAML-ish key:value) followed by markdown body.
 *  - Only TaskRunner calls write(); workers cannot write here directly
 *    (PathPolicyEnforcer enforces, see P4).
 */

export function stagingPath(projectRoot: string, memoryRoot = ".minimum"): string {
	return path.join(projectRoot, memoryRoot, "_staging");
}

export function candidateFilename(taskId: string, persona: PersonaId): string {
	return `${taskId}.${persona}.memory.md`;
}

export async function ensureStagingDir(
	projectRoot: string,
	memoryRoot = ".minimum",
): Promise<string> {
	const dir = stagingPath(projectRoot, memoryRoot);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

/** Persist a candidate. Overwrites if the same (taskId, persona) re-runs. */
export async function writeCandidate(
	projectRoot: string,
	candidate: MemoryCandidate,
	memoryRoot = ".minimum",
): Promise<string> {
	const dir = await ensureStagingDir(projectRoot, memoryRoot);
	const file = path.join(dir, candidateFilename(candidate.sourceTask, candidate.persona));
	await fs.writeFile(file, serializeCandidate(candidate), "utf-8");
	return file;
}

/** Read all staged candidates; returns [] if dir missing. */
export async function listCandidates(
	projectRoot: string,
	memoryRoot = ".minimum",
): Promise<MemoryCandidate[]> {
	const dir = stagingPath(projectRoot, memoryRoot);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return [];
	}
	const out: MemoryCandidate[] = [];
	for (const name of entries) {
		if (!name.endsWith(".memory.md")) continue;
		const full = path.join(dir, name);
		try {
			const text = await fs.readFile(full, "utf-8");
			const parsed = parseCandidate(text);
			if (parsed) out.push({ ...parsed, sourcePath: full });
		} catch {
			// skip malformed files; don't crash the W4 review
		}
	}
	return out;
}

/** Remove a candidate after governance has acted on it. */
export async function deleteCandidate(filePath: string): Promise<void> {
	await fs.rm(filePath, { force: true });
}

/** Remove all candidates for the given task ids; used at end of W4. */
export async function clearForEpic(
	projectRoot: string,
	taskIds: string[],
	memoryRoot = ".minimum",
): Promise<void> {
	const dir = stagingPath(projectRoot, memoryRoot);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return; // dir missing — nothing to do
	}
	const ids = new Set(taskIds);
	for (const name of entries) {
		if (!name.endsWith(".memory.md")) continue;
		// filename is `<taskId>.<persona>.memory.md`; taskId is everything before
		// the persona+suffix.
		const taskId = name.slice(0, name.indexOf(".memory.md")).split(".").slice(0, -1).join(".");
		if (ids.has(taskId)) await fs.rm(path.join(dir, name), { force: true });
	}
}

// ── Frontmatter parsing/serializing ─────────────────────────────────────────

const FRONTMATTER_FENCE = "---";

export function serializeCandidate(c: MemoryCandidate): string {
	const lines = [
		FRONTMATTER_FENCE,
		`source_task: ${c.sourceTask}`,
		`persona: ${c.persona}`,
		`scope: ${c.scope}`,
		`confidence: ${c.confidence}`,
		...(c.decision ? [`decision: ${c.decision}`] : []),
		...(c.reviewReason ? [`review_reason: ${c.reviewReason.replace(/\n/g, " ")}`] : []),
		"related_files:",
		...c.relatedFiles.map((f) => `  - ${f}`),
		FRONTMATTER_FENCE,
		"",
		c.body.trimStart(),
	];
	return lines.join("\n").trimEnd() + "\n";
}

/** Parse a candidate file's text; returns null if frontmatter is malformed. */
export function parseCandidate(rawText: string): Omit<MemoryCandidate, "sourcePath"> | null {
	// Normalize CRLF so files written/edited on Windows still parse (parseYaml
	// already tolerates \r\n; keep this parser consistent).
	const text = rawText.replace(/\r\n/g, "\n");
	const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!m) return null;
	const front = m[1]!;
	const body = m[2]!;

	const fm: Record<string, string | string[]> = {};
	const lines = front.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (!line.trim()) { i++; continue; }
		const [k, ...rest] = line.split(":");
		const key = k!.trim();
		const value = rest.join(":").trim();
		if (key === "related_files" && !value) {
			// list follows
			const items: string[] = [];
			i++;
			while (i < lines.length && /^\s+-\s/.test(lines[i]!)) {
				items.push(lines[i]!.replace(/^\s+-\s/, "").trim());
				i++;
			}
			fm[key] = items;
			continue;
		}
		// list inline like `related_files: []` is allowed
		if (value === "[]") fm[key] = [];
		else fm[key] = value;
		i++;
	}

	const required = ["source_task", "persona", "scope", "confidence"];
	for (const k of required) {
		const v = fm[k];
		// Required keys must be present and non-empty strings (an empty
		// source_task would otherwise yield a malformed ".persona" candidateId).
		if (typeof v !== "string" || v.trim() === "") return null;
	}

	const confidence = fm.confidence as MemoryConfidence;
	if (!["high", "medium", "low"].includes(confidence)) return null;

	const decision = typeof fm.decision === "string" ? fm.decision : undefined;
	if (decision && !["merge", "update", "archive", "reject", "needs_review"].includes(decision)) return null;

	return {
		sourceTask: fm.source_task as string,
		persona: fm.persona as PersonaId,
		scope: fm.scope as string,
		confidence,
		relatedFiles: Array.isArray(fm.related_files) ? (fm.related_files as string[]) : [],
		body: body.trim(),
		...(decision && { decision: decision as MemoryCandidate["decision"] }),
		...(typeof fm.review_reason === "string" && { reviewReason: fm.review_reason }),
	};
}
