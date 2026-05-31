import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PersonaId } from "../../personas/Persona.js";
import type { TaskContract } from "../../orchestration/TaskContract.js";
import { matchGlob, normalizeRelPath } from "../../tools/policy/PathPolicyEnforcer.js";
import { CharBudget } from "../../utils/tokenBudget.js";
import { refreshMemoryIndex } from "./MemoryIndex.js";
import type { MemoryCandidate, MemoryConfidence } from "./types.js";

/**
 * ContextPackBuilder — assemble a per-task, per-persona context document.
 *
 * Coupling point W1→W2 (see IMPLEMENTATION_PLAN §3.2): instead of handing a
 * downstream worker the raw canonical memory, the master gives it a *bounded*
 * ContextPack containing only:
 *   - the task objective / acceptance / constraints (always),
 *   - the canonical memory sections the master loaded for this epic,
 *   - the W1 perception findings whose related files overlap what this task
 *     is allowed to touch.
 *
 * This enforces invariant #5: a subagent's system prompt contains the
 * ContextPack, never the raw canonical memory.
 */

const DEFAULT_MAX_TOKENS = 4_000;

const CONFIDENCE_WEIGHT: Record<MemoryConfidence, number> = {
	high: 3,
	medium: 2,
	low: 1,
};

/** A canonical memory section already loaded by the master (key + body). */
export interface CanonicalSection {
	key: string;
	/** Repo-relative path of the source file, e.g. ".minimum/architecture.md". */
	path: string;
	body: string;
}

export interface ContextPackInput {
	contract: TaskContract;
	/** Staged W1 perception findings to draw from. */
	candidates: MemoryCandidate[];
	/** Canonical sections the master loaded for this epic/taskType. */
	canonicalSections?: CanonicalSection[];
	maxTokens?: number;
}

export interface ContextPack {
	taskId: string;
	personaId: PersonaId;
	text: string;
	/** "<sourceTask>.<persona>" ids of candidates that made it into the pack. */
	includedCandidates: string[];
	includedSections: string[];
	approxTokens: number;
	truncated: boolean;
}

/**
 * Build the ContextPack text deterministically. Pure function — no I/O.
 *
 * Objective/acceptance/constraints are always included (they are small and
 * essential). Canonical sections and perception findings are added in
 * relevance order until the token budget is exhausted; anything cut sets
 * `truncated`.
 */
export function buildContextPack(input: ContextPackInput): ContextPack {
	const { contract } = input;
	const budget = new CharBudget(input.maxTokens ?? DEFAULT_MAX_TOKENS);

	// --- Always-included header (objective + acceptance + constraints) ---
	budget.pushAlways(renderHead(contract));

	// --- Canonical memory sections (already task-type filtered upstream) ---
	const includedSections: string[] = [];
	const canonical = input.canonicalSections ?? [];
	if (canonical.length > 0 && budget.tryPush("\n## Project Memory\n")) {
		for (const sec of canonical) {
			const body = sec.body.trim();
			if (!body) continue;
			const block = `\n### ${sec.key} (\`${sec.path}\`)\n\n${body}\n`;
			if (!budget.tryPush(block)) break;
			includedSections.push(sec.key);
		}
	}

	// --- Perception findings (ranked by relevance to this task) ---
	const ranked = rankCandidates(input.candidates, contract);
	const includedCandidates: string[] = [];
	if (
		ranked.length > 0 &&
		budget.tryPush(
			"\n## Perception Findings\n\n> Upstream W1 findings filtered to files this task touches.\n",
		)
	) {
		for (const c of ranked) {
			if (!budget.tryPush(renderCandidate(c))) break;
			includedCandidates.push(`${c.sourceTask}.${c.persona}`);
		}
	}

	return {
		taskId: contract.taskId,
		personaId: contract.personaId,
		text: budget.text,
		includedCandidates,
		includedSections,
		approxTokens: budget.approxTokens,
		truncated: budget.truncated,
	};
}

function renderHead(contract: TaskContract): string {
	const lines: string[] = [];
	lines.push(`# Context Pack — ${contract.taskId} (${contract.personaId})\n`);
	lines.push(`\n## Objective\n\n${contract.objective.trim()}\n`);
	if (contract.acceptance.length > 0) {
		lines.push("\n## Acceptance Criteria\n\n");
		lines.push(contract.acceptance.map((a) => `- ${a}`).join("\n") + "\n");
	}
	if (contract.inputs.constraints.length > 0) {
		lines.push("\n## Constraints\n\n");
		lines.push(contract.inputs.constraints.map((c) => `- ${c}`).join("\n") + "\n");
	}
	return lines.join("");
}

function renderCandidate(c: MemoryCandidate): string {
	const files = c.relatedFiles.length > 0 ? c.relatedFiles.join(", ") : "—";
	return [
		`\n### ${c.persona} — ${c.scope} (confidence: ${c.confidence})\n`,
		`related files: ${files}\n\n`,
		c.body.trim() + "\n",
	].join("");
}

/**
 * Rank candidates by relevance to a task. A candidate is more relevant when
 * its related files overlap the files this task is allowed to write, and when
 * its self-rated confidence is higher. The task's own staged candidate (same
 * sourceTask) and empty-body candidates are dropped.
 *
 * Sort is stable: relevance desc, then sourceTask asc, then persona asc.
 */
export function rankCandidates(
	candidates: MemoryCandidate[],
	contract: TaskContract,
): MemoryCandidate[] {
	const allowed = contract.pathPolicy.allowedGlobs;
	const scored = candidates
		.filter((c) => c.sourceTask !== contract.taskId && c.body.trim().length > 0)
		.map((c) => ({ c, score: relevanceScore(c, allowed) }));

	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (a.c.sourceTask !== b.c.sourceTask)
			return a.c.sourceTask < b.c.sourceTask ? -1 : 1;
		return a.c.persona < b.c.persona ? -1 : a.c.persona > b.c.persona ? 1 : 0;
	});

	return scored.map((s) => s.c);
}

function relevanceScore(c: MemoryCandidate, allowedGlobs: string[]): number {
	let overlap = 0;
	for (const file of c.relatedFiles) {
		// Normalize the same way the write-policy gate does, so ranking agrees
		// with it for "./"-prefixed or backslash paths.
		const norm = normalizeRelPath(file);
		if (allowedGlobs.some((g) => matchGlob(norm, g))) overlap++;
	}
	return overlap * 10 + CONFIDENCE_WEIGHT[c.confidence];
}

/** Repo-relative path where a task's ContextPack is written. */
export function contextPackPath(
	projectRoot: string,
	epicId: string,
	taskId: string,
	memoryRoot = ".minimum",
): string {
	return path.join(
		projectRoot,
		memoryRoot,
		"tasks",
		epicId,
		"context-packs",
		`${taskId}.md`,
	);
}

/**
 * Build and persist a ContextPack to tasks/<epic>/context-packs/<taskId>.md.
 * Returns the absolute path written. Master (or context_builder) owns this
 * write — workers receive the path via TaskInputs.contextPack.
 */
export async function writeContextPack(
	projectRoot: string,
	input: ContextPackInput,
	memoryRoot = ".minimum",
): Promise<{ pack: ContextPack; path: string }> {
	const pack = buildContextPack(input);
	const filePath = contextPackPath(
		projectRoot,
		input.contract.epicId,
		input.contract.taskId,
		memoryRoot,
	);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, pack.text, "utf-8");
	await refreshMemoryIndex(projectRoot);
	return { pack, path: filePath };
}
