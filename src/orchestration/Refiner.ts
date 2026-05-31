import { getPersona } from "../personas/PersonaRegistry.js";
import { extractJsonBlock, isObj } from "../utils/guards.js";
import { findGlobConflicts, validateContract } from "./ContractValidator.js";
import type {
	CoarseDag,
	CoarseTask,
	TaskContract,
	TaskInputs,
} from "./TaskContract.js";

/**
 * Refiner — the W0.5 second pass.
 *
 * After Wave 1 (perception), the master re-examines tasks marked
 * `needs_refine` and emits a `<refine>` block that supplies the concrete
 * `allowedGlobs` (and optionally forbiddenGlobs / acceptance / constraints)
 * that were left "TBD-after-refine" at coarse-compile time. This module
 * parses that block and assembles the coarse DAG into fully-formed,
 * validated TaskContracts ready for the WaveScheduler.
 */

export interface RefinementEntry {
	taskId: string;
	allowedGlobs: string[];
	forbiddenGlobs?: string[];
	acceptance?: string[];
	constraints?: string[];
	/** Inline markdown emitted by the master during W0.5; persisted before launch. */
	contextPack?: string;
	/** Absolute path to the persisted context pack, filled by MiMoPipeline. */
	contextPackPath?: string;
}

export interface RefineCompileSuccess {
	ok: true;
	entries: Map<string, RefinementEntry>;
}

export interface RefineCompileFailure {
	ok: false;
	error: string;
	raw?: string;
}

export type RefineCompileResult = RefineCompileSuccess | RefineCompileFailure;

/** Extract and parse the master's <refine> block. */
export function compileRefinement(text: string): RefineCompileResult {
	const block = extractJsonBlock(text, "refine");
	if (!block.ok) return { ok: false, error: block.error, ...(block.raw && { raw: block.raw }) };
	const { value: parsed, raw } = block;

	if (!isObj(parsed) || !Array.isArray(parsed.tasks))
		return { ok: false, error: "refine.tasks must be an array", raw };

	const entries = new Map<string, RefinementEntry>();
	for (const [i, t] of (parsed.tasks as unknown[]).entries()) {
		const r = validateEntry(t, i);
		if (!r.ok) return { ok: false, error: r.error, raw };
		if (entries.has(r.entry.taskId))
			return { ok: false, error: `duplicate refine entry ${r.entry.taskId}`, raw };
		entries.set(r.entry.taskId, r.entry);
	}
	return { ok: true, entries };
}

function validateEntry(
	raw: unknown,
	index: number,
): { ok: true; entry: RefinementEntry } | { ok: false; error: string } {
	if (!isObj(raw)) return { ok: false, error: `refine.tasks[${index}] must be an object` };
	const taskId = raw.taskId ?? raw.id;
	if (typeof taskId !== "string" || !taskId)
		return { ok: false, error: `refine.tasks[${index}].taskId required` };

	const allowedGlobs = raw.allowedGlobs ?? raw.allowed_globs;
	if (!Array.isArray(allowedGlobs) || !allowedGlobs.every((g) => typeof g === "string"))
		return { ok: false, error: `refine entry ${taskId}: allowedGlobs must be string[]` };

	const forbiddenGlobs = raw.forbiddenGlobs ?? raw.forbidden_globs;
	if (forbiddenGlobs !== undefined && !Array.isArray(forbiddenGlobs))
		return { ok: false, error: `refine entry ${taskId}: forbiddenGlobs must be array or omitted` };

	const acceptance = raw.acceptance;
	if (acceptance !== undefined && !Array.isArray(acceptance))
		return { ok: false, error: `refine entry ${taskId}: acceptance must be array or omitted` };

	const constraints = raw.constraints;
	if (constraints !== undefined && !Array.isArray(constraints))
		return { ok: false, error: `refine entry ${taskId}: constraints must be array or omitted` };

	const contextPack = raw.contextPack ?? raw.context_pack;
	if (contextPack !== undefined && typeof contextPack !== "string")
		return { ok: false, error: `refine entry ${taskId}: contextPack must be string or omitted` };

	return {
		ok: true,
		entry: {
			taskId,
			allowedGlobs: allowedGlobs as string[],
			...(forbiddenGlobs !== undefined && { forbiddenGlobs: forbiddenGlobs as string[] }),
			...(acceptance !== undefined && { acceptance: acceptance as string[] }),
			...(constraints !== undefined && { constraints: constraints as string[] }),
			...(contextPack !== undefined && { contextPack }),
		},
	};
}

export interface RefineOptions {
	/** Shared base inputs applied to every task (userGoal carried verbatim). */
	inputs: TaskInputs;
	/** Refinement entries keyed by taskId (from compileRefinement). */
	refinement: Map<string, RefinementEntry>;
	/** Fallback acceptance when a task has none from the refinement. */
	defaultAcceptance?: string[];
	/** When true (default), validate the resulting contracts. */
	validate?: boolean;
}

export interface RefineResult {
	contracts: TaskContract[];
	errors: Array<{ taskId: string; errors: string[] }>;
}

/**
 * Assemble a coarse DAG + refinement into final TaskContracts.
 *
 * For each coarse task:
 *  - needs_refine tasks must have a refinement entry with allowedGlobs;
 *    otherwise an error is recorded and the task gets empty globs.
 *  - non-refine tasks keep their coarse allowedGlobs (refinement may still
 *    override them if an entry is present).
 *  - acceptance comes from the refinement entry, else defaultAcceptance,
 *    else a synthesized "complete: <objective>".
 *  - outputSchema is derived from the persona registry.
 */
export function refineDag(dag: CoarseDag, opts: RefineOptions): RefineResult {
	const errors: RefineResult["errors"] = [];
	const contracts: TaskContract[] = [];
	const validate = opts.validate ?? true;

	for (const phase of dag.phases) {
		for (const task of phase.tasks) {
			const { contract, error } = assembleContract(dag.epicId, phase.id, task, opts);
			if (error) errors.push({ taskId: task.id, errors: [error] });
			contracts.push(contract);
		}
	}

	if (validate) {
		for (const c of contracts) {
			const r = validateContract(c);
			if (!r.ok) errors.push({ taskId: c.taskId, errors: r.errors });
		}
		const conflicts = findGlobConflicts(contracts);
		if (conflicts.length > 0) {
			errors.push({
				taskId: "_glob_conflict",
				errors: conflicts.map((c) => `${c.taskA} and ${c.taskB} both claim ${c.glob}`),
			});
		}
	}

	return { contracts, errors };
}

function assembleContract(
	epicId: string,
	phaseId: string,
	task: CoarseTask,
	opts: RefineOptions,
): { contract: TaskContract; error?: string } {
	const entry = opts.refinement.get(task.id);
	let error: string | undefined;

	let allowedGlobs: string[];
	if (entry) {
		allowedGlobs = entry.allowedGlobs;
	} else if (task.needsRefine) {
		error = `task ${task.id} needs_refine but has no refinement entry`;
		allowedGlobs = [];
	} else {
		allowedGlobs = task.allowedGlobs ?? [];
	}

	// Read-only personas never carry writable globs, regardless of refinement.
	const persona = safeOutputSchema(task);
	if (persona.readOnly) allowedGlobs = [];

	const acceptance =
		entry?.acceptance ??
		opts.defaultAcceptance ??
		[`complete: ${task.objective}`];

	const contract: TaskContract = {
		taskId: task.id,
		phase: phaseId,
		epicId,
		personaId: task.personaId,
		objective: task.objective,
		inputs: {
			...opts.inputs,
			...(entry?.contextPackPath && { contextPack: entry.contextPackPath }),
			...(entry?.constraints && {
				constraints: [...opts.inputs.constraints, ...entry.constraints],
			}),
		},
		pathPolicy: {
			allowedGlobs,
			forbiddenGlobs: entry?.forbiddenGlobs ?? [],
		},
		acceptance,
		outputSchema: persona.outputSchema,
		parallelGroup: task.parallelGroup,
		dependsOn: task.dependsOn,
		abortOnConflict: false,
	};

	return { contract, ...(error && { error }) };
}

function safeOutputSchema(
	task: CoarseTask,
): { outputSchema: TaskContract["outputSchema"]; readOnly: boolean } {
	try {
		const p = getPersona(task.personaId);
		return { outputSchema: p.outputSchema, readOnly: !p.pathPolicy.canWrite };
	} catch {
		// Unknown persona — validateContract will flag it; pick a safe default.
		return { outputSchema: "task_report", readOnly: false };
	}
}
