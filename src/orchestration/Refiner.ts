import { getPersona } from "../personas/PersonaRegistry.js";
import { extractJsonBlock, isObj } from "../utils/guards.js";
import { findGlobConflicts, validateContract } from "./ContractValidator.js";
import type {
	CoarseDag,
	CoarseTask,
	LaunchArtifact,
	LaunchRequirement,
	TaskContract,
	TaskInputs,
} from "./TaskContract.js";

/**
 * Refiner — the W0.5 second pass.
 *
 * After the W1 perception stage, the master re-examines tasks marked
 * `needs_refine` and emits a `<refine>` block that supplies the concrete
 * `allowedGlobs` (and optionally forbiddenGlobs / acceptance / constraints)
 * that were left "TBD-after-refine" at coarse-compile time. This module
 * parses that block and assembles the coarse DAG into fully-formed,
 * validated TaskContracts ready for the dynamic DAG harness.
 */

export interface RefinementEntry {
	taskId: string;
	allowedGlobs: string[];
	forbiddenGlobs?: string[];
	acceptance?: string[];
	nonGoals?: string[];
	blockedCondition?: string;
	launchRequirements?: LaunchRequirement[];
	constraints?: string[];
	/** Inline markdown emitted by the master during W0.5; persisted before launch. */
	contextPack?: string;
	/** Absolute path to the persisted context pack, filled by MiMoPipeline. */
	contextPackPath?: string;
	/** Skills the master grants this task (ids from the grantable catalog). */
	grantedSkills?: string[];
	/** MCP tool names the master grants this task. */
	grantedMcpTools?: string[];
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

	const nonGoals = raw.nonGoals ?? raw.non_goals;
	if (nonGoals !== undefined && !Array.isArray(nonGoals))
		return { ok: false, error: `refine entry ${taskId}: nonGoals must be array or omitted` };

	const blockedCondition = raw.blockedCondition ?? raw.blocked_condition;
	if (blockedCondition !== undefined && typeof blockedCondition !== "string")
		return { ok: false, error: `refine entry ${taskId}: blockedCondition must be string or omitted` };

	const launchRequirements = raw.launchRequirements ?? raw.launch_requirements;
	if (launchRequirements !== undefined) {
		const lr = validateLaunchRequirements(launchRequirements, taskId);
		if (!lr.ok) return { ok: false, error: lr.error };
	}

	const constraints = raw.constraints;
	if (constraints !== undefined && !Array.isArray(constraints))
		return { ok: false, error: `refine entry ${taskId}: constraints must be array or omitted` };

	const contextPack = raw.contextPack ?? raw.context_pack;
	if (contextPack !== undefined && typeof contextPack !== "string")
		return { ok: false, error: `refine entry ${taskId}: contextPack must be string or omitted` };

	const grantedSkills = raw.grantedSkills ?? raw.granted_skills ?? [];
	if (!Array.isArray(grantedSkills) || !grantedSkills.every((s) => typeof s === "string"))
		return { ok: false, error: `refine entry ${taskId}: grantedSkills must be string[] or omitted` };

	const grantedMcpTools = raw.grantedMcpTools ?? raw.granted_mcp_tools ?? [];
	if (!Array.isArray(grantedMcpTools) || !grantedMcpTools.every((s) => typeof s === "string"))
		return { ok: false, error: `refine entry ${taskId}: grantedMcpTools must be string[] or omitted` };

	return {
		ok: true,
		entry: {
			taskId,
			allowedGlobs: allowedGlobs as string[],
			...(forbiddenGlobs !== undefined && { forbiddenGlobs: forbiddenGlobs as string[] }),
			...(acceptance !== undefined && { acceptance: acceptance as string[] }),
			...(nonGoals !== undefined && { nonGoals: nonGoals as string[] }),
			...(blockedCondition !== undefined && { blockedCondition }),
			...(launchRequirements !== undefined && {
				launchRequirements: launchRequirements as LaunchRequirement[],
			}),
			...(constraints !== undefined && { constraints: constraints as string[] }),
			...(contextPack !== undefined && { contextPack }),
			grantedSkills: grantedSkills as string[],
			grantedMcpTools: grantedMcpTools as string[],
		},
	};
}

const LAUNCH_ARTIFACTS = new Set<LaunchArtifact>([
	"file_list",
	"relevant_files",
	"tech_stack",
	"test_commands",
	"static_compile_commands",
	"visual_summary",
]);

function validateLaunchRequirements(
	raw: unknown,
	taskId: string,
): { ok: true } | { ok: false; error: string } {
	if (!Array.isArray(raw))
		return { ok: false, error: `refine entry ${taskId}: launchRequirements must be array or omitted` };
	for (const [i, item] of raw.entries()) {
		if (!isObj(item))
			return { ok: false, error: `refine entry ${taskId}: launchRequirements[${i}] must be an object` };
		if (typeof item.sourceTaskId !== "string" || !item.sourceTaskId)
			return { ok: false, error: `refine entry ${taskId}: launchRequirements[${i}].sourceTaskId required` };
		if (typeof item.artifact !== "string" || !LAUNCH_ARTIFACTS.has(item.artifact as LaunchArtifact))
			return { ok: false, error: `refine entry ${taskId}: launchRequirements[${i}].artifact must be one of ${[...LAUNCH_ARTIFACTS].join(",")}` };
		if (item.required !== undefined && typeof item.required !== "boolean")
			return { ok: false, error: `refine entry ${taskId}: launchRequirements[${i}].required must be boolean or omitted` };
		item.required = item.required ?? true;
	}
	return { ok: true };
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
	} else if (task.needsRefine && isRepairTaskWithAllowedGlobs(task)) {
		allowedGlobs = task.allowedGlobs;
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
		task.acceptance ??
		opts.defaultAcceptance ??
		[`complete: ${task.objective}`];
	const nonGoals = entry?.nonGoals ?? [`do not change files outside ${task.id}'s Task Contract`];
	const blockedCondition = entry?.blockedCondition ?? `blocked if required context for ${task.id} is missing or contradictory`;
	if (persona.readOnly === false && task.needsRefine && entry && !entry.blockedCondition) {
		error = mergeError(error, `task ${task.id} needs_refine write contract requires explicit blockedCondition`);
	}
	const staticCompileCommands = opts.inputs.staticCompileCommands ?? [];
	// Only gate write tasks that can actually touch compilable source. A task whose
	// allowedGlobs are purely docs/markdown (an audit, report, or findings task) must
	// not be failed by a whole-project typecheck/build it cannot influence — otherwise
	// it inherits unrelated compile breakage and is wrongly marked failed. test_runner
	// is exempt: validating compilation IS its job, even with no writable globs.
	const writesCompilableSource = allowedGlobs.some(globMayMatchCompilableSource);
	const requiresPostStaticCompile =
		(task.personaId === "test_runner" || (persona.readOnly === false && writesCompilableSource)) &&
		staticCompileCommands.length > 0;

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
		nonGoals,
		blockedCondition,
		...(entry?.launchRequirements && { launchRequirements: entry.launchRequirements }),
		...(requiresPostStaticCompile && {
			postStaticCompile: {
				required: true,
				commands: staticCompileCommands,
			},
		}),
		outputSchema: persona.outputSchema,
		parallelGroup: task.parallelGroup,
		dependsOn: task.dependsOn,
		grantedSkills: entry?.grantedSkills ?? [],
		grantedMcpTools: entry?.grantedMcpTools ?? [],
		abortOnConflict: false,
	};

	return { contract, ...(error && { error }) };
}

function mergeError(current: string | undefined, next: string): string {
	return current ? `${current}; ${next}` : next;
}

function isRepairTaskWithAllowedGlobs(task: CoarseTask): task is CoarseTask & { allowedGlobs: string[] } {
	return task.id.startsWith("T3.5-") && Array.isArray(task.allowedGlobs) && task.allowedGlobs.length > 0;
}

const COMPILABLE_SOURCE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;
const NON_SOURCE_EXT =
	/\.(?:mdx?|markdown|json5?|jsonc|ya?ml|toml|txt|csv|tsv|svg|png|jpe?g|gif|webp|ico|lock|html?|css|s[ac]ss|less)$/i;

/**
 * Whether a write glob could match a file the static-compile commands actually
 * check. A specific docs/markdown path (e.g. `docs/report.md`, `tasks/x/findings.md`)
 * returns false so report/audit tasks aren't gated on tsc/build. Wildcards or
 * extension-less paths return true (conservative — they may include source).
 */
function globMayMatchCompilableSource(glob: string): boolean {
	const g = glob.replace(/\\/g, "/").trim();
	if (!g) return false;
	if (COMPILABLE_SOURCE_EXT.test(g)) return true;
	if (NON_SOURCE_EXT.test(g)) return false;
	// No recognised extension: a wildcard or bare directory may still cover source.
	return /[*?[\]]/.test(g) || !/\.[a-z0-9]+$/i.test(g);
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
