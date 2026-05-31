import * as fs from "node:fs/promises";
import * as path from "node:path";
import { extractJsonBlock, isObj } from "../../utils/guards.js";
import { refreshMemoryIndex } from "./MemoryIndex.js";
import { clearForEpic } from "./MemoryStaging.js";
import type { MemoryCandidate, MergeAction, MergeDecision } from "./types.js";

/**
 * MemoryGovernor — apply the master's W4 finalize decisions to canonical
 * memory.
 *
 * The master emits a single `<finalize>` block (see master-planner.md) with a
 * patch merge plan and a list of memory decisions. This module parses that
 * block and executes the memory side: merge/update append provenance-tagged
 * entries into canonical files, archive moves a candidate to `_archive/`, and
 * reject discards it. After all decisions, the epic's staging files are
 * cleared (invariant #3) and every merged entry carries source_task / persona
 * / related_files (invariant #4).
 *
 * The patch merge plan is parsed and surfaced but executed by the patch
 * subsystem, not here.
 */

export interface PatchMergeEntry {
	taskId: string;
	order: number;
}

export interface Finalize {
	patchMergePlan: PatchMergeEntry[];
	memoryDecisions: MergeDecision[];
}

export interface FinalizeCompileSuccess {
	ok: true;
	finalize: Finalize;
}
export interface FinalizeCompileFailure {
	ok: false;
	error: string;
	raw?: string;
}
export type FinalizeCompileResult =
	| FinalizeCompileSuccess
	| FinalizeCompileFailure;

const VALID_ACTIONS: MergeAction[] = ["merge", "update", "archive", "reject"];

/** Extract and parse the master's <finalize> block. */
export function compileFinalize(text: string): FinalizeCompileResult {
	const block = extractJsonBlock(text, "finalize");
	if (!block.ok) return { ok: false, error: block.error, ...(block.raw && { raw: block.raw }) };
	const { value: parsed, raw } = block;
	if (!isObj(parsed)) return { ok: false, error: "finalize must be an object", raw };

	const planRaw = parsed.patch_merge_plan ?? parsed.patchMergePlan ?? [];
	if (!Array.isArray(planRaw))
		return { ok: false, error: "patch_merge_plan must be an array", raw };
	const patchMergePlan: PatchMergeEntry[] = [];
	for (const [i, p] of (planRaw as unknown[]).entries()) {
		if (!isObj(p) || typeof p.taskId !== "string" || typeof p.order !== "number")
			return { ok: false, error: `patch_merge_plan[${i}] needs {taskId, order}`, raw };
		patchMergePlan.push({ taskId: p.taskId, order: p.order });
	}

	const decRaw = parsed.memory_decisions ?? parsed.memoryDecisions ?? [];
	if (!Array.isArray(decRaw))
		return { ok: false, error: "memory_decisions must be an array", raw };
	const memoryDecisions: MergeDecision[] = [];
	for (const [i, d] of (decRaw as unknown[]).entries()) {
		const r = validateDecision(d, i);
		if (!r.ok) return { ok: false, error: r.error, raw };
		memoryDecisions.push(r.decision);
	}

	return { ok: true, finalize: { patchMergePlan, memoryDecisions } };
}

function validateDecision(
	raw: unknown,
	index: number,
): { ok: true; decision: MergeDecision } | { ok: false; error: string } {
	if (!isObj(raw)) return { ok: false, error: `memory_decisions[${index}] must be an object` };
	const candidateId = raw.candidateId ?? raw.candidate_id;
	if (typeof candidateId !== "string" || !candidateId)
		return { ok: false, error: `memory_decisions[${index}].candidateId required` };
	const action = raw.action;
	if (typeof action !== "string" || !VALID_ACTIONS.includes(action as MergeAction))
		return { ok: false, error: `decision ${candidateId}: action must be one of ${VALID_ACTIONS.join(",")}` };
	const reason = raw.reason;
	if (typeof reason !== "string" || !reason)
		return { ok: false, error: `decision ${candidateId}: reason required` };

	const target = raw.target;
	if ((action === "merge" || action === "update") && (typeof target !== "string" || !target))
		return { ok: false, error: `decision ${candidateId}: ${action} requires target` };

	return {
		ok: true,
		decision: {
			candidateId,
			action: action as MergeAction,
			...(typeof target === "string" && { target }),
			...(typeof raw.section === "string" && { section: raw.section }),
			reason,
		},
	};
}

export interface ApplyOptions {
	/** Task ids whose staging files to clear after applying (defaults to candidates'). */
	epicTaskIds?: string[];
	memoryRoot?: string;
	/** Injectable clock for deterministic archive paths in tests. */
	now?: Date;
}

export interface AppliedDecision {
	candidateId: string;
	action: MergeAction;
	/** Absolute path written, for merge/update/archive. */
	path?: string;
}

export interface FinalizeReport {
	applied: AppliedDecision[];
	errors: Array<{ candidateId: string; error: string }>;
	stagingCleared: boolean;
}

/**
 * Apply the memory decisions of a finalize result to canonical memory.
 * Candidates are matched by `<sourceTask>.<persona>`. Unknown candidate ids,
 * or merge/update without a target, are recorded as errors but do not abort
 * the remaining decisions.
 */
export async function applyFinalize(
	projectRoot: string,
	finalize: Finalize,
	candidates: MemoryCandidate[],
	opts: ApplyOptions = {},
): Promise<FinalizeReport> {
	const memoryRoot = opts.memoryRoot ?? ".minimum";
	const byId = new Map(candidates.map((c) => [`${c.sourceTask}.${c.persona}`, c]));
	const applied: AppliedDecision[] = [];
	const errors: FinalizeReport["errors"] = [];

	for (const decision of finalize.memoryDecisions) {
		const candidate = byId.get(decision.candidateId);
		if (!candidate) {
			errors.push({ candidateId: decision.candidateId, error: "candidate not found in staging" });
			continue;
		}
		try {
			const written = await applyDecision(projectRoot, memoryRoot, decision, candidate, opts.now);
			applied.push({ candidateId: decision.candidateId, action: decision.action, ...(written && { path: written }) });
		} catch (e) {
			errors.push({ candidateId: decision.candidateId, error: e instanceof Error ? e.message : String(e) });
		}
	}

	// Invariant #3: staging is empty after W4.
	const taskIds = opts.epicTaskIds ?? [...new Set(candidates.map((c) => c.sourceTask))];
	let stagingCleared = false;
	try {
		await clearForEpic(projectRoot, taskIds, memoryRoot);
		stagingCleared = true;
	} catch {
		stagingCleared = false;
	}
	await refreshMemoryIndex(projectRoot);

	return { applied, errors, stagingCleared };
}

async function applyDecision(
	projectRoot: string,
	memoryRoot: string,
	decision: MergeDecision,
	candidate: MemoryCandidate,
	now?: Date,
): Promise<string | undefined> {
	switch (decision.action) {
		case "reject":
			return undefined;
		case "archive":
			return archiveCandidate(projectRoot, memoryRoot, decision.candidateId, candidate, now);
		case "merge":
		case "update": {
			const target = decision.target!; // validated present at compile time
			const section = decision.section ?? "Notes";
			const filePath = path.join(projectRoot, memoryRoot, target);
			const entry = renderEntry(candidate);
			await upsertSectionInFile(filePath, section, entry, decision.action === "update" ? "replace" : "append");
			return filePath;
		}
	}
}

async function archiveCandidate(
	projectRoot: string,
	memoryRoot: string,
	candidateId: string,
	candidate: MemoryCandidate,
	now = new Date(),
): Promise<string> {
	const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
	const dir = path.join(projectRoot, memoryRoot, "_archive", ym);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${candidateId}.md`);
	await fs.writeFile(filePath, `## archived: ${candidateId}\n\n${renderEntry(candidate)}\n`, "utf-8");
	return filePath;
}

/**
 * Render a candidate as a canonical entry. The provenance comment guarantees
 * invariant #4: every merged entry carries source_task, persona, related_files.
 */
export function renderEntry(c: MemoryCandidate): string {
	const related = c.relatedFiles.join(", ");
	const provenance = `<!-- mimo-memory source_task=${c.sourceTask} persona=${c.persona} related_files=${related} -->`;
	return `${provenance}\n${c.body.trim()}\n`;
}

// ── Markdown section editor ──────────────────────────────────────────────────

/** Read, upsert a `## section`, and write back. Creates the file if missing. */
export async function upsertSectionInFile(
	filePath: string,
	section: string,
	body: string,
	mode: "append" | "replace",
): Promise<void> {
	let existing = "";
	try {
		existing = await fs.readFile(filePath, "utf-8");
	} catch {
		existing = "";
	}
	const next = upsertSection(existing, section, body, mode);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, next, "utf-8");
}

/**
 * Upsert an H2 section in markdown text.
 *  - append: add body to the end of the section (or create the section).
 *  - replace: replace the section's entire body (or create the section).
 * Section boundary = the heading line until the next H1/H2 or EOF.
 */
export function upsertSection(
	text: string,
	section: string,
	body: string,
	mode: "append" | "replace",
): string {
	const lines = text.split("\n");
	const headingRe = new RegExp(`^##\\s+${escapeRegex(section)}\\s*$`);

	// Heading scan is fence-aware: a "## ..." line inside a ``` code fence is
	// content, not a heading.
	let start = -1;
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		if (isFenceLine(lines[i]!)) inFence = !inFence;
		if (!inFence && headingRe.test(lines[i]!)) {
			start = i;
			break;
		}
	}

	if (start === -1) {
		// Section missing — append it at the end.
		const prefix = text.trim().length > 0 ? text.replace(/\n+$/, "") + "\n\n" : "";
		return `${prefix}## ${section}\n\n${body.trim()}\n`;
	}

	// Find the end of the section (next H1/H2 or EOF), also fence-aware.
	let end = lines.length;
	inFence = false;
	for (let i = start + 1; i < lines.length; i++) {
		if (isFenceLine(lines[i]!)) inFence = !inFence;
		if (!inFence && /^#{1,2}\s/.test(lines[i]!)) {
			end = i;
			break;
		}
	}

	const before = lines.slice(0, start + 1); // includes the heading
	const sectionBody = lines.slice(start + 1, end);
	const after = lines.slice(end);

	let newSectionBody: string[];
	if (mode === "replace") {
		newSectionBody = ["", body.trim(), ""];
	} else {
		// append: keep existing body, add the new entry after it
		const trimmed = trimBlankEdges(sectionBody);
		newSectionBody =
			trimmed.length > 0 ? ["", ...trimmed, "", body.trim(), ""] : ["", body.trim(), ""];
	}

	// No global blank-line collapse — that would corrupt fenced code blocks in
	// the body. The seams above already contribute at most one blank line each.
	const rebuilt = [...before, ...newSectionBody, ...after].join("\n");
	return rebuilt.replace(/\n+$/, "") + "\n";
}

/** True for a markdown code-fence delimiter line (``` or ~~~). */
function isFenceLine(line: string): boolean {
	return /^\s*(```|~~~)/.test(line);
}

function trimBlankEdges(lines: string[]): string[] {
	let s = 0;
	let e = lines.length;
	while (s < e && lines[s]!.trim() === "") s++;
	while (e > s && lines[e - 1]!.trim() === "") e--;
	return lines.slice(s, e);
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
