import type { PersonaId } from "../personas/Persona.js";
import { listPersonaIds } from "../personas/PersonaRegistry.js";
import { extractJsonBlock, isObj } from "../utils/guards.js";
import type { CoarseDag, CoarsePhase, CoarseTask } from "./TaskContract.js";

/**
 * TaskCompiler — parse master_planner's <task_dag> XML block into a typed
 * CoarseDag. The master emits JSON inside the tag (see master-planner.md);
 * this module extracts it and runs structural validation.
 *
 * Why JSON-inside-XML: the model is reliable at producing valid JSON when
 * wrapped in a fence; mixing free-text and structured output via XML tags
 * is the same pattern EngineBridge uses for tool_result.
 */

export interface CompileSuccess {
	ok: true;
	dag: CoarseDag;
}

export interface CompileFailure {
	ok: false;
	error: string;
	/** Raw text of the <task_dag> block, for debugging. */
	raw?: string;
}

export type CompileResult = CompileSuccess | CompileFailure;

/** Single source of truth for valid persona ids — derived from the registry. */
const VALID_PERSONA_IDS = new Set<PersonaId>(listPersonaIds());

/** Extract and parse the <task_dag> block from master_planner output. */
export function compileCoarse(text: string): CompileResult {
	const block = extractJsonBlock(text, "task_dag");
	if (!block.ok) return { ok: false, error: block.error, ...(block.raw && { raw: block.raw }) };

	const r = validateCoarseDag(block.value);
	if (!r.ok) return { ok: false, error: r.error, raw: block.raw };
	return { ok: true, dag: r.dag };
}

function validateCoarseDag(input: unknown): CompileResult {
	if (!isObj(input)) return { ok: false, error: "task_dag must be an object" };
	const epicId = input.epic ?? input.epicId;
	if (typeof epicId !== "string" || !epicId)
		return { ok: false, error: "task_dag.epic is required (string)" };

	if (!Array.isArray(input.phases))
		return { ok: false, error: "task_dag.phases must be an array" };

	const phases: CoarsePhase[] = [];
	const seenTaskIds = new Set<string>();
	for (const [i, p] of (input.phases as unknown[]).entries()) {
		const r = validatePhase(p, i);
		if (!r.ok) return r;
		for (const t of r.phase.tasks) {
			if (seenTaskIds.has(t.id))
				return { ok: false, error: `duplicate task id ${t.id}` };
			seenTaskIds.add(t.id);
		}
		phases.push(r.phase);
	}

	return { ok: true, dag: { epicId, phases } };
}

function validatePhase(
	raw: unknown,
	index: number,
):
	| { ok: true; phase: CoarsePhase }
	| { ok: false; error: string } {
	if (!isObj(raw)) return { ok: false, error: `phase[${index}] must be an object` };
	if (typeof raw.id !== "string" || !raw.id)
		return { ok: false, error: `phase[${index}].id required` };
	if (typeof raw.name !== "string" || !raw.name)
		return { ok: false, error: `phase[${index}].name required` };
	if (!Array.isArray(raw.tasks))
		return { ok: false, error: `phase[${index}].tasks must be an array` };

	const tasks: CoarseTask[] = [];
	for (const [j, t] of (raw.tasks as unknown[]).entries()) {
		const r = validateTask(t, `phase[${index}].tasks[${j}]`);
		if (!r.ok) return r;
		tasks.push(r.task);
	}
	return { ok: true, phase: { id: raw.id, name: raw.name, tasks } };
}

/** Normalize surface variations the LLM commonly emits. Strict semantics
 * only: accept case + dash differences but reject synonyms. */
function normalizePersona(s: string): string {
	return s.trim().toLowerCase().replace(/-/g, "_");
}

function validateTask(
	raw: unknown,
	prefix: string,
):
	| { ok: true; task: CoarseTask }
	| { ok: false; error: string } {
	if (!isObj(raw)) return { ok: false, error: `${prefix} must be an object` };
	const id = raw.id;
	const rawPersona = raw.persona ?? raw.role;
	const persona =
		typeof rawPersona === "string" ? normalizePersona(rawPersona) : undefined;
	const objective = raw.objective;
	const parallelGroup = raw.parallelGroup ?? raw.parallel_group;
	const dependsOn = raw.dependsOn ?? raw.depends_on ?? [];
	const needsRefine = raw.needsRefine ?? raw.needs_refine ?? false;
	const allowedGlobs = raw.allowedGlobs ?? raw.allowed_globs ?? undefined;

	if (typeof id !== "string" || !id)
		return { ok: false, error: `${prefix}.id required` };
	if (!persona || !VALID_PERSONA_IDS.has(persona as PersonaId))
		return {
			ok: false,
			error: `${prefix}.persona must be one of ${[...VALID_PERSONA_IDS].join(",")} (got ${JSON.stringify(rawPersona)})`,
		};
	if (typeof objective !== "string" || objective.trim().length < 4)
		return { ok: false, error: `${prefix}.objective must be a non-empty string` };
	if (typeof parallelGroup !== "string" || !parallelGroup)
		return { ok: false, error: `${prefix}.parallelGroup required` };
	if (!Array.isArray(dependsOn) || !dependsOn.every((d) => typeof d === "string"))
		return { ok: false, error: `${prefix}.dependsOn must be array of strings` };
	if (allowedGlobs !== undefined && !Array.isArray(allowedGlobs))
		return { ok: false, error: `${prefix}.allowedGlobs must be array or omitted` };

	return {
		ok: true,
		task: {
			id,
			personaId: persona as PersonaId,
			objective,
			parallelGroup,
			dependsOn: dependsOn as string[],
			needsRefine: Boolean(needsRefine),
			allowedGlobs: allowedGlobs as string[] | undefined,
		},
	};
}

/** Classify a user request into a taskType used by MemoryLoader. */
export function classifyTaskType(
	userRequest: string,
): "frontend" | "backend" | "debugging" | "mixed" {
	const lower = userRequest.toLowerCase();
	const fe = /\b(ui|page|component|design|layout|tsx|jsx|tailwind|css|button|form|preview)\b/.test(lower);
	const be = /\b(api|endpoint|router|database|sql|migration|backend|fastapi|express|server|schema)\b/.test(lower);
	const dbg = /\b(bug|error|fix|stack trace|fail|crash|debug|regression)\b/.test(lower);
	if (dbg && !fe && !be) return "debugging";
	if (fe && be) return "mixed";
	if (fe) return "frontend";
	if (be) return "backend";
	return "mixed";
}
