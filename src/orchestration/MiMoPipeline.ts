import {
	applyFinalize,
	compileFinalize,
	listCandidates,
	loadCanonicalMemory,
	type FinalizeReport,
} from "../memory/governance/index.js";
import type { MemoryCandidate } from "../memory/governance/types.js";
import type { PersonaId } from "../personas/Persona.js";
import { compileCoarse, classifyTaskType } from "./TaskCompiler.js";
import { buildWaves } from "./TaskGraph.js";
import type { CoarseDag, TaskContract, TaskInputs } from "./TaskContract.js";
import { compileRefinement, refineDag } from "./Refiner.js";
import { schedule, type WaveEvent } from "./WaveScheduler.js";
import type { TaskResult, WorkerExecutor } from "./TaskRunner.js";

/**
 * MiMoPipeline — drive a user request through the W0–W4 wave pipeline.
 *
 * This is the top-level wiring that ties the orchestration and memory layers
 * together. The master_planner's three LLM touchpoints (compile / refine /
 * finalize) are injected via a PlannerBridge so the control flow is unit-
 * testable with stubs; workers run through an injected WorkerExecutor.
 *
 *   W0   load canonical memory → master compiles coarse DAG
 *   W1   perception workers (vision / repo_scout / context_builder) run
 *   W0.5 master refines → final TaskContracts
 *   W2/3 implementation + validation workers run
 *   W4   master finalizes → memory governance applied, staging cleared
 */

export const PERCEPTION_PERSONAS: ReadonlySet<PersonaId> = new Set<PersonaId>([
	"vision",
	"repo_scout",
	"context_builder",
]);

export type PipelinePhase = "W0" | "W1" | "W0.5" | "W2/3" | "W4";

export type PipelineEvent =
	| { type: "phase_start"; phase: PipelinePhase; label: string }
	| { type: "memory_loaded"; includedKeys: string[]; approxTokens: number; truncated: boolean }
	| { type: "dag_compiled"; epicId: string; taskCount: number }
	| { type: "wave"; event: WaveEvent }
	| { type: "refine_done"; contractCount: number; errorCount: number }
	| { type: "finalize_done"; report: FinalizeReport }
	| { type: "pipeline_complete"; results: TaskResult[] }
	| { type: "pipeline_error"; phase: PipelinePhase; error: string };

/** The three master_planner LLM touchpoints. */
export interface PlannerBridge {
	/** W0: returns master output containing a <task_dag> block. */
	compile(userRequest: string, memoryPrefix: string): Promise<string>;
	/** W0.5: returns master output containing a <refine> block. */
	refine(dag: CoarseDag, perception: TaskResult[]): Promise<string>;
	/** W4: returns master output containing a <finalize> block. */
	finalize(
		results: TaskResult[],
		candidates: MemoryCandidate[],
		canonicalText: string,
	): Promise<string>;
}

export interface PipelineOptions {
	projectRoot: string;
	planner: PlannerBridge;
	executor: WorkerExecutor;
	onEvent?: (event: PipelineEvent) => void;
}

export interface PipelineResult {
	ok: boolean;
	results: TaskResult[];
	finalize?: FinalizeReport;
	error?: string;
}

export async function runPipeline(
	userRequest: string,
	opts: PipelineOptions,
): Promise<PipelineResult> {
	const emit = opts.onEvent ?? (() => {});
	const taskType = classifyTaskType(userRequest);
	const allResults: TaskResult[] = [];

	// ── W0: load memory, compile coarse DAG ──────────────────────────────────
	emit({ type: "phase_start", phase: "W0", label: "compile" });
	const memory = await loadCanonicalMemory(opts.projectRoot, taskType);
	emit({
		type: "memory_loaded",
		includedKeys: memory.includedKeys,
		approxTokens: memory.approxTokens,
		truncated: memory.truncated,
	});

	let compiledText: string;
	try {
		compiledText = await opts.planner.compile(userRequest, memory.text);
	} catch (e) {
		return fail(emit, "W0", e);
	}
	const compiled = compileCoarse(compiledText);
	if (!compiled.ok) {
		emit({ type: "pipeline_error", phase: "W0", error: compiled.error });
		return { ok: false, results: [], error: compiled.error };
	}
	const dag = compiled.dag;
	const taskCount = dag.phases.reduce((n, p) => n + p.tasks.length, 0);
	emit({ type: "dag_compiled", epicId: dag.epicId, taskCount });

	const baseInputs: TaskInputs = { userGoal: userRequest, artifacts: [], constraints: [] };

	// ── W1: perception ───────────────────────────────────────────────────────
	emit({ type: "phase_start", phase: "W1", label: "perception" });
	const perceptionDag = filterDag(dag, (p) => PERCEPTION_PERSONAS.has(p));
	const { contracts: perceptionContracts } = refineDag(perceptionDag, {
		inputs: baseInputs,
		refinement: new Map(),
	});
	if (perceptionContracts.length > 0) {
		try {
			const perceptionResults = await runWaves(perceptionContracts, opts, emit);
			allResults.push(...perceptionResults);
		} catch (e) {
			return fail(emit, "W1", e, allResults);
		}
	}

	// ── W0.5: refine ──────────────────────────────────────────────────────────
	emit({ type: "phase_start", phase: "W0.5", label: "refine" });
	let refinement = new Map();
	try {
		const refineText = await opts.planner.refine(dag, allResults);
		const parsed = compileRefinement(refineText);
		if (parsed.ok) refinement = parsed.entries;
	} catch (e) {
		return fail(emit, "W0.5", e);
	}
	const { contracts: allContracts, errors: refineErrors } = refineDag(dag, {
		inputs: baseInputs,
		refinement,
	});
	emit({ type: "refine_done", contractCount: allContracts.length, errorCount: refineErrors.length });

	// ── W2/3: implementation + validation (exclude perception, already run) ───
	emit({ type: "phase_start", phase: "W2/3", label: "implement + validate" });
	const implContracts = stripPerceptionDeps(
		allContracts.filter((c) => !PERCEPTION_PERSONAS.has(c.personaId)),
	);
	if (implContracts.length > 0) {
		try {
			const implResults = await runWaves(implContracts, opts, emit);
			allResults.push(...implResults);
		} catch (e) {
			return fail(emit, "W2/3", e, allResults);
		}
	}

	// ── W4: finalize + memory governance ──────────────────────────────────────
	emit({ type: "phase_start", phase: "W4", label: "finalize" });
	const candidates = await listCandidates(opts.projectRoot);
	let finalizeReport: FinalizeReport | undefined;
	try {
		const finalizeText = await opts.planner.finalize(allResults, candidates, memory.text);
		const fin = compileFinalize(finalizeText);
		if (fin.ok) {
			const epicTaskIds = allContracts.map((c) => c.taskId);
			finalizeReport = await applyFinalize(opts.projectRoot, fin.finalize, candidates, {
				epicTaskIds,
			});
			emit({ type: "finalize_done", report: finalizeReport });
		} else {
			emit({ type: "pipeline_error", phase: "W4", error: fin.error });
		}
	} catch (e) {
		return fail(emit, "W4", e, allResults);
	}

	emit({ type: "pipeline_complete", results: allResults });
	return { ok: true, results: allResults, ...(finalizeReport && { finalize: finalizeReport }) };
}

async function runWaves(
	contracts: TaskContract[],
	opts: PipelineOptions,
	emit: (e: PipelineEvent) => void,
): Promise<TaskResult[]> {
	const { waves } = buildWaves(contracts, { validate: false });
	return schedule(waves, {
		projectRoot: opts.projectRoot,
		executor: opts.executor,
		onEvent: (event) => emit({ type: "wave", event }),
	});
}

/** Keep only tasks whose persona satisfies the predicate; drop empty phases. */
function filterDag(dag: CoarseDag, keep: (p: PersonaId) => boolean): CoarseDag {
	return {
		epicId: dag.epicId,
		phases: dag.phases
			.map((ph) => ({ ...ph, tasks: ph.tasks.filter((t) => keep(t.personaId)) }))
			.filter((ph) => ph.tasks.length > 0),
	};
}

/**
 * Drop dependsOn entries that point at perception tasks: those already ran in
 * W1, so for the W2/3 schedule they are satisfied and would otherwise be
 * flagged as dangling.
 */
function stripPerceptionDeps(contracts: TaskContract[]): TaskContract[] {
	const implIds = new Set(contracts.map((c) => c.taskId));
	return contracts.map((c) => ({
		...c,
		dependsOn: c.dependsOn.filter((d) => implIds.has(d)),
	}));
}

function fail(
	emit: (e: PipelineEvent) => void,
	phase: PipelinePhase,
	e: unknown,
	results: TaskResult[] = [],
): PipelineResult {
	const error = e instanceof Error ? e.message : String(e);
	emit({ type: "pipeline_error", phase, error });
	return { ok: false, results, error };
}
