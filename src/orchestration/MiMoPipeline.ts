import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	applyFinalize,
	compileFinalize,
	contextPackPath,
	listCandidates,
	loadCanonicalMemory,
	memoryIndexPath,
	refreshMemoryIndex,
	type FinalizeReport,
} from "../memory/governance/index.js";
import type { MemoryCandidate } from "../memory/governance/types.js";
import type { PersonaId } from "../personas/Persona.js";
import { compileCoarse, classifyTaskType } from "./TaskCompiler.js";
import { buildWaves } from "./TaskGraph.js";
import type { CoarseDag, TaskContract, TaskInputs } from "./TaskContract.js";
import { compileRefinement, refineDag, type RefinementEntry } from "./Refiner.js";
import {
	compileMissionCheck,
	loopBackTasksToCoarseTasks,
	type MissionCheckInput,
	type MissionLoopBackTask,
} from "./MissionChecker.js";
import {
	emptyArtifactPaths,
	writeContracts,
	writeDag,
	writeMissionCheck,
	writeRefinement,
	writeRepairDag,
	type ArtifactPaths,
} from "./PipelineArtifactStore.js";
import { schedule, type WaveEvent } from "./WaveScheduler.js";
import type { TaskResult, WorkerExecutor } from "./TaskRunner.js";

/**
 * MiMoPipeline — drive a user request through the W0–W4 wave pipeline.
 *
 * This is the top-level wiring that ties the orchestration and memory layers
 * together. The planner/checker LLM touchpoints (compile / refine /
 * mission check / finalize) are injected via a PlannerBridge so the control flow is unit-
 * testable with stubs; workers run through an injected WorkerExecutor.
 *
 *   W0   load canonical memory → master compiles coarse DAG
 *   W1   perception workers (vision / repo_scout / context_builder) run
 *   W0.5 master refines → final TaskContracts
 *   W2/3 implementation + validation workers run
 *   W3.5 inline mission_checker accepts or routes repair tasks back to W1
 *   W4   master finalizes → memory governance applied, staging cleared
 */

export const PERCEPTION_PERSONAS: ReadonlySet<PersonaId> = new Set<PersonaId>([
	"vision",
	"repo_scout",
	"context_builder",
]);

export type PipelinePhase = "W0" | "W1" | "W0.5" | "W2/3" | "W3.5" | "W4";

export type PipelineEvent =
	| { type: "phase_start"; phase: PipelinePhase; label: string }
	| { type: "memory_loaded"; includedKeys: string[]; approxTokens: number; truncated: boolean }
	| { type: "dag_compiled"; epicId: string; taskCount: number }
	| { type: "compile_retry"; phase: "W0"; attempt: 1; error: string }
	| { type: "wave"; event: WaveEvent }
	| { type: "refine_done"; contractCount: number; errorCount: number }
	| { type: "finalize_done"; report: FinalizeReport }
	| { type: "pipeline_complete"; results: TaskResult[] }
	| { type: "pipeline_error"; phase: PipelinePhase; error: string };

/** Planner/checker LLM touchpoints used by the pipeline. */
export interface PlannerBridge {
	/**
	 * W0: returns master output containing a <task_dag> block.
	 * `feedback` is optional retry context — when present, the implementation
	 * MUST surface it to the LLM as an additional user message so the model
	 * can self-correct (e.g. compiler validation error from a prior attempt).
	 */
	compile(userRequest: string, memoryPrefix: string, feedback?: string): Promise<string>;
	/** W0.5: returns master output containing a <refine> block. */
	refine(dag: CoarseDag, perception: TaskResult[], memoryPrefix: string): Promise<string>;
	/** W3.5: returns a mission checker Markdown report. */
	checkMission(input: MissionCheckInput): Promise<string>;
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
	maxMissionRepairLoops?: number;
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
	const resolvedContracts: TaskContract[] = [];
	const refinements: RefinementEntry[] = [];
	const knownIssues: string[] = [];
	const artifactPaths = emptyArtifactPaths();
	artifactPaths.memoryIndex = memoryIndexPath(opts.projectRoot);
	const maxMissionRepairLoops = opts.maxMissionRepairLoops ?? 1;

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
	let compiled: ReturnType<typeof compileCoarse>;
	try {
		compiledText = await opts.planner.compile(userRequest, memory.text);
	} catch (e) {
		return fail(emit, "W0", e);
	}
	compiled = compileCoarse(compiledText);
	if (!compiled.ok) {
		const firstError = compiled.error;
		emit({ type: "compile_retry", phase: "W0", attempt: 1, error: firstError });
		try {
			compiledText = await opts.planner.compile(userRequest, memory.text, firstError);
		} catch (e) {
			return fail(emit, "W0", e);
		}
		compiled = compileCoarse(compiledText);
		if (!compiled.ok) {
			const combined = `W0 compile failed twice; first: ${firstError}; retry: ${compiled.error}`;
			emit({ type: "pipeline_error", phase: "W0", error: combined });
			return { ok: false, results: [], error: combined };
		}
	}
	const dag = compiled.dag;
	const taskCount = dag.phases.reduce((n, p) => n + p.tasks.length, 0);
	try {
		artifactPaths.dag = await writeDag(opts.projectRoot, dag.epicId, dag);
		await refreshMemoryIndex(opts.projectRoot);
	} catch (e) {
		return fail(emit, "W0", e);
	}
	emit({ type: "dag_compiled", epicId: dag.epicId, taskCount });

	const baseInputs: TaskInputs = { userGoal: userRequest, artifacts: [], constraints: [] };

	const initialPass = await runDagPass({
		dag,
		opts,
		emit,
		allResults,
		resolvedContracts,
		refinements,
		knownIssues,
		baseInputs,
		memoryText: memory.text,
		labelSuffix: "",
		passId: "initial",
		artifactPaths,
	});
	if (!initialPass.ok) return initialPass.result;

	let missionLoopIndex = 0;
	while (true) {
		emit({ type: "phase_start", phase: "W3.5", label: "mission check" });
		let missionText: string;
		try {
			missionText = await opts.planner.checkMission({
				userRequest,
				dag,
				refinements,
				results: allResults,
				canonicalMemory: memory.text,
				knownIssues,
				loopIndex: missionLoopIndex,
				maxRepairLoops: maxMissionRepairLoops,
				artifactPaths,
			});
		} catch (e) {
			return fail(emit, "W3.5", e, allResults);
		}

		const mission = compileMissionCheck(missionText);
		if (!mission.ok) {
			return fail(emit, "W3.5", mission.error, allResults);
		}
		try {
			const written = await writeMissionCheck(
				opts.projectRoot,
				dag.epicId,
				missionLoopIndex + 1,
				missionText,
				mission.report,
			);
			artifactPaths.missionChecks.push(written.markdownPath, written.jsonPath);
			await refreshMemoryIndex(opts.projectRoot);
		} catch (e) {
			return fail(emit, "W3.5", e, allResults);
		}

		if (mission.report.decision === "APPROVED_TO_W4") {
			break;
		}
		if (mission.report.decision === "NEEDS_HUMAN_CONFIRMATION") {
			return fail(
				emit,
				"W3.5",
				`mission checker requires human confirmation${mission.report.reason ? `: ${mission.report.reason}` : ""}`,
				allResults,
			);
		}
		if (missionLoopIndex >= maxMissionRepairLoops) {
			return fail(
				emit,
				"W3.5",
				`mission checker requested another loop-back after ${maxMissionRepairLoops} repair loop(s)`,
				allResults,
			);
		}
		if (mission.report.tasks.length === 0) {
			return fail(emit, "W3.5", "mission checker requested loop-back but provided no tasks", allResults);
		}

		const repairDag = buildRepairDag(dag.epicId, missionLoopIndex, mission.report.tasks);
		try {
			const repairDagPath = await writeRepairDag(
				opts.projectRoot,
				dag.epicId,
				missionLoopIndex + 1,
				repairDag,
			);
			artifactPaths.repairDags.push(repairDagPath);
			await refreshMemoryIndex(opts.projectRoot);
		} catch (e) {
			return fail(emit, "W3.5", e, allResults);
		}
		missionLoopIndex++;
		const repairPass = await runDagPass({
			dag: repairDag,
			opts,
			emit,
			allResults,
			resolvedContracts,
			refinements,
			knownIssues,
			baseInputs,
			memoryText: memory.text,
			labelSuffix: " repair",
			passId: `repair-${missionLoopIndex}`,
			artifactPaths,
		});
		if (!repairPass.ok) return repairPass.result;
	}

	// ── W4: finalize + memory governance ──────────────────────────────────────
	emit({ type: "phase_start", phase: "W4", label: "finalize" });
	const candidates = await listCandidates(opts.projectRoot);
	let finalizeReport: FinalizeReport | undefined;
	try {
		const finalizeText = await opts.planner.finalize(allResults, candidates, memory.text);
		const fin = compileFinalize(finalizeText);
		if (fin.ok) {
			const epicTaskIds = resolvedContracts.map((c) => c.taskId);
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

interface DagPassOptions {
	dag: CoarseDag;
	opts: PipelineOptions;
	emit: (e: PipelineEvent) => void;
	allResults: TaskResult[];
	resolvedContracts: TaskContract[];
	refinements: RefinementEntry[];
	knownIssues: string[];
	baseInputs: TaskInputs;
	memoryText: string;
	labelSuffix: string;
	passId: string;
	artifactPaths: ArtifactPaths;
}

type DagPassResult = { ok: true } | { ok: false; result: PipelineResult };

async function runDagPass(args: DagPassOptions): Promise<DagPassResult> {
	const {
		dag,
		opts,
		emit,
		allResults,
		resolvedContracts,
		refinements,
		knownIssues,
		baseInputs,
		memoryText,
		labelSuffix,
		passId,
		artifactPaths,
	} = args;

	// ── W1: perception ───────────────────────────────────────────────────────
	emit({ type: "phase_start", phase: "W1", label: `perception${labelSuffix}` });
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
			return { ok: false, result: fail(emit, "W1", e, allResults) };
		}
	}

	// ── W0.5: refine ──────────────────────────────────────────────────────────
	emit({ type: "phase_start", phase: "W0.5", label: `refine${labelSuffix}` });
	let refinement: Map<string, RefinementEntry> = new Map();
	let refinementParsed = false;
	try {
		const refineText = await opts.planner.refine(dag, allResults, memoryText);
		const parsed = compileRefinement(refineText);
		if (parsed.ok) {
			refinement = parsed.entries;
			refinementParsed = true;
			await writeInlineContextPacks(opts.projectRoot, dag.epicId, refinement);
			refinements.push(...refinement.values());
		} else {
			knownIssues.push(`W0.5 refine parse failed for ${dag.epicId}: ${parsed.error}`);
			const refinementPath = await writeRefinement(
				opts.projectRoot,
				dag.epicId,
				passId,
				[],
				parsed.error,
			);
			artifactPaths.refinements.push(refinementPath);
			await refreshMemoryIndex(opts.projectRoot);
		}
	} catch (e) {
		return { ok: false, result: fail(emit, "W0.5", e, allResults) };
	}
	if (refinementParsed) {
		try {
			const refinementPath = await writeRefinement(
				opts.projectRoot,
				dag.epicId,
				passId,
				refinement.values(),
			);
			artifactPaths.refinements.push(refinementPath);
			await refreshMemoryIndex(opts.projectRoot);
		} catch (e) {
			return { ok: false, result: fail(emit, "W0.5", e, allResults) };
		}
	}
	const { contracts: allContracts, errors: refineErrors } = refineDag(dag, {
		inputs: baseInputs,
		refinement,
	});
	resolvedContracts.push(...allContracts);
	if (refineErrors.length > 0) {
		for (const error of refineErrors) {
			knownIssues.push(`W0.5 ${error.taskId}: ${error.errors.join("; ")}`);
		}
	}
	try {
		const contractsPath = await writeContracts(opts.projectRoot, dag.epicId, passId, allContracts, refineErrors);
		artifactPaths.contracts.push(contractsPath);
		await refreshMemoryIndex(opts.projectRoot);
	} catch (e) {
		return { ok: false, result: fail(emit, "W0.5", e, allResults) };
	}
	emit({ type: "refine_done", contractCount: allContracts.length, errorCount: refineErrors.length });

	// ── W2/3: implementation + validation (exclude perception, already run) ───
	emit({ type: "phase_start", phase: "W2/3", label: `implement + validate${labelSuffix}` });
	const implContracts = stripPerceptionDeps(
		allContracts.filter((c) => !PERCEPTION_PERSONAS.has(c.personaId)),
	);
	if (implContracts.length > 0) {
		try {
			const implResults = await runWaves(implContracts, opts, emit);
			allResults.push(...implResults);
		} catch (e) {
			return { ok: false, result: fail(emit, "W2/3", e, allResults) };
		}
	}

	return { ok: true };
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

async function writeInlineContextPacks(
	projectRoot: string,
	epicId: string,
	refinement: Map<string, RefinementEntry>,
): Promise<void> {
	for (const entry of refinement.values()) {
		const text = entry.contextPack?.trim();
		if (!text) continue;

		const filePath = contextPackPath(projectRoot, epicId, entry.taskId);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, text.endsWith("\n") ? text : `${text}\n`, "utf-8");
		entry.contextPackPath = filePath;
	}
	await refreshMemoryIndex(projectRoot);
}

function buildRepairDag(
	epicId: string,
	loopIndex: number,
	tasks: MissionLoopBackTask[],
): CoarseDag {
	return {
		epicId,
		phases: [
			{
				id: `P3.5-repair-${loopIndex + 1}`,
				name: "mission-check repair",
				tasks: loopBackTasksToCoarseTasks(tasks, loopIndex),
			},
		],
	};
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
