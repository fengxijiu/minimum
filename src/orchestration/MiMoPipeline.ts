import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	applyFinalize,
	compileFinalize,
	contextPackPath,
	defaultMemorySectionForCandidate,
	defaultMemoryTargetForCandidate,
	listCandidates,
	loadCanonicalMemory,
	memoryIndexPath,
	refreshMemoryIndex,
	type FinalizeReport,
} from "../memory/governance/index.js";
import type { MemoryCandidate, MergeDecision } from "../memory/governance/types.js";
import type { PersonaId } from "../personas/Persona.js";
import { compileCoarse, classifyTaskType } from "./TaskCompiler.js";
import { buildWaves } from "./TaskGraph.js";
import type { CoarseDag, TaskContract, TaskInputs } from "./TaskContract.js";
import { compileRefinement, refineDag, type RefinementEntry } from "./Refiner.js";
import { validateGrants, type GrantableCatalog } from "./CapabilityCatalog.js";
import { buildArtifactMap, evaluateLaunchGate, isContextGapBlocked } from "./LaunchGate.js";
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
	writeDagConfirmation,
	writeMissionCheck,
	writeRefinement,
	writeRepairDag,
	type ArtifactPaths,
} from "./PipelineArtifactStore.js";
import { schedule, type WaveEvent } from "./WaveScheduler.js";
import { stageLabel, stageName } from "./StageDisplay.js";
import type { TaskResult, WorkerExecutor } from "./TaskRunner.js";
import type { ChoicePayload, ConfirmationGate } from "../tools/choice/ConfirmationGate.js";

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
	"web_searcher",
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
	| { type: "dag_confirmation_requested"; phase: "W0.5"; passId: string; brief: string; flow: string; artifactPath?: string }
	| { type: "mission_parse_failed"; phase: "W3.5"; error: string; rawExcerpt: string; loopIndex: number; attempt: number }
	| { type: "pipeline_choice"; phase: PipelinePhase; choiceId: string; reason: string }
	| { type: "human_confirmation_required"; phase: PipelinePhase; reason: string }
	| { type: "gate_retry"; phase: "W2/3"; taskId: string; attempt: 1; reason: string }
	| { type: "task_deferred"; phase: "W2/3"; taskId: string; reason: string; blockedCondition?: string }
	| { type: "finalize_done"; report: FinalizeReport }
	| {
			type: "pipeline_complete";
			results: TaskResult[];
			/** Original user goal, echoed so the summary can restate it. */
			goal?: string;
			/** W4 human-readable conclusion answering the goal (from synthesize). */
			conclusion?: string;
			/** Terminal task ids (nothing depends on them) — the actual deliverables. */
			leafTaskIds?: string[];
			/** Persisted artifact file paths produced by the run. */
			artifacts?: string[];
	  }
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
	refine(
		dag: CoarseDag,
		perception: TaskResult[],
		memoryPrefix: string,
		catalog?: GrantableCatalog,
		feedback?: string,
	): Promise<string>;
	/** W3.5: returns a mission checker Markdown report. */
	checkMission(input: MissionCheckInput, feedback?: string): Promise<string>;
	/** W4: returns master output containing a <finalize> block. */
	finalize(
		results: TaskResult[],
		candidates: MemoryCandidate[],
		canonicalText: string,
	): Promise<string>;
	/**
	 * Post-W4: compose a concise, human-readable conclusion answering the
	 * original goal from the task reports. Returns text containing a single
	 * <conclusion> block (Markdown body). Best-effort — the pipeline tolerates
	 * an empty or malformed result and simply omits the conclusion.
	 */
	synthesize(userRequest: string, results: TaskResult[]): Promise<string>;
}

/** Pull the Markdown body out of a <conclusion> block, or undefined if absent/empty. */
export function extractConclusion(text: string): string | undefined {
	const m = /<conclusion>([\s\S]*?)<\/conclusion>/i.exec(text);
	const body = (m?.[1] ?? "").trim();
	return body || undefined;
}

/** Task ids that no other contract depends on — the terminal deliverables of the DAG. */
export function leafTaskIdsOf(contracts: TaskContract[]): string[] {
	const referenced = new Set(contracts.flatMap((c) => c.dependsOn));
	return contracts.map((c) => c.taskId).filter((id) => !referenced.has(id));
}

/**
 * Default automatic W3.5 mission-repair budget. This is the number of
 * code_executor -> test_runner -> code_executor repair loops the pipeline will
 * run on its own before pausing for a human at the cap gate. Set above 1 so a
 * single failing repair leg does not immediately halt the run; the user can
 * still extend the cap interactively when it is reached.
 */
export const DEFAULT_MAX_MISSION_REPAIR_LOOPS = 2;

export interface PipelineOptions {
	projectRoot: string;
	planner: PlannerBridge;
	executor: WorkerExecutor;
	onEvent?: (event: PipelineEvent) => void;
	/** Automatic repair loops before the cap gate. Defaults to {@link DEFAULT_MAX_MISSION_REPAIR_LOOPS}. */
	maxMissionRepairLoops?: number;
	choiceGate?: ConfirmationGate;
	/** Catalog of grantable skills + MCP tools, injected into W0.5 refine. */
	grantableCatalog?: GrantableCatalog;
}

export interface PipelineResult {
	ok: boolean;
	results: TaskResult[];
	finalize?: FinalizeReport;
	error?: string;
	statusReason?: "human_confirmation" | "user_override" | "complete" | "error";
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
	const gateRetryKeys = new Set<string>();
	const artifactPaths = emptyArtifactPaths();
	artifactPaths.memoryIndex = memoryIndexPath(opts.projectRoot);
	let maxMissionRepairLoops = opts.maxMissionRepairLoops ?? DEFAULT_MAX_MISSION_REPAIR_LOOPS;
	let statusReason: PipelineResult["statusReason"] = "complete";

	// ── W0: load memory, compile coarse DAG ──────────────────────────────────
	emit({ type: "phase_start", phase: "W0", label: stageName("W0") });
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
		gateRetryKeys,
	});
	if (!initialPass.ok) return initialPass.result;

	let missionLoopIndex = 0;
	while (true) {
		emit({ type: "phase_start", phase: "W3.5", label: stageName("W3.5") });
		let missionText: string;
		let missionFeedback: string | undefined;
		let missionParseRetryUsed = false;
		let mission = undefined as ReturnType<typeof compileMissionCheck> | undefined;
		while (true) {
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
				}, missionFeedback);
			} catch (e) {
				return fail(emit, "W3.5", e, allResults);
			}

			mission = compileMissionCheck(missionText);
			if (mission.ok) break;

			const rawExcerpt = summarizeRawReport(mission.raw ?? missionText);
			emit({
				type: "mission_parse_failed",
				phase: "W3.5",
				error: mission.error,
				rawExcerpt,
				loopIndex: missionLoopIndex,
				attempt: missionParseRetryUsed ? 2 : 1,
			});
			const choice = await askPipelineChoice(opts.choiceGate, {
				question: "Accept 解析失败，如何恢复？",
				context: [`错误: ${mission.error}`, `Loop: ${missionLoopIndex}`, rawExcerpt ? `原始摘要: ${rawExcerpt}` : ""].filter(Boolean).join("\n"),
				options: [
					{ id: "retry_w35", title: "重试 Accept", summary: missionParseRetryUsed ? "已重试一次，再试仍可能失败。" : "带解析反馈重跑 mission checker。" },
					{ id: "needs_human_confirmation", title: "暂停", summary: "安全停止，不发错误。" },
					{ id: "approve_to_w4", title: "推进到 Finalize", summary: "用户 override，跳过本轮检查。" },
				],
				allowCustom: false,
			});
			if (!choice || choice === "needs_human_confirmation") {
				const reason = choice ? "W3.5 parse failure requires human confirmation" : "W3.5 parse failure choice cancelled";
				emit({ type: "human_confirmation_required", phase: "W3.5", reason });
				return { ok: false, results: allResults, statusReason: "human_confirmation", error: reason };
			}
			emit({ type: "pipeline_choice", phase: "W3.5", choiceId: choice, reason: "mission parse failure" });
			if (choice === "approve_to_w4") {
				statusReason = "user_override";
				knownIssues.push(`W3.5 mission parse failure overridden by user: ${mission.error}`);
				break;
			}
			if (choice !== "retry_w35") {
				const reason = `unsupported W3.5 choice: ${choice}`;
				emit({ type: "human_confirmation_required", phase: "W3.5", reason });
				return { ok: false, results: allResults, statusReason: "human_confirmation", error: reason };
			}
			if (missionParseRetryUsed) {
				const reason = "W3.5 parse retry already used";
				emit({ type: "human_confirmation_required", phase: "W3.5", reason });
				return { ok: false, results: allResults, statusReason: "human_confirmation", error: reason };
			}
			missionFeedback = `${mission.error}\nRaw report excerpt:\n${rawExcerpt || "(empty)"}`;
			missionParseRetryUsed = true;
		}
		if (!mission?.ok) break;
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
			const reason = `mission checker requires human confirmation${mission.report.reason ? `: ${mission.report.reason}` : ""}`;
			emit({ type: "human_confirmation_required", phase: "W3.5", reason });
			return { ok: false, results: allResults, statusReason: "human_confirmation", error: reason };
		}
		if (missionLoopIndex >= maxMissionRepairLoops) {
			const capChoice = await askPipelineChoice(opts.choiceGate, {
				question: `Accept 修复上限 (${maxMissionRepairLoops} 轮) 已达，如何继续？`,
				context: mission.report.reason ? `原因: ${mission.report.reason}` : undefined,
				options: [
					{ id: "continue_repair", title: "再修一轮", summary: "突破上限一次，继续新修复任务。" },
					{ id: "stop_for_human", title: "暂停", summary: "安全停止，不发错误。" },
					{ id: "approve_to_w4", title: "强制进入 Finalize", summary: "用户 override，跳过剩余修复。" },
				],
				allowCustom: false,
			});
			if (!capChoice || capChoice === "stop_for_human") {
				const reason = capChoice
					? `W3.5 mission repair cap reached after ${maxMissionRepairLoops} loop(s); user requested human confirmation`
					: "W3.5 mission repair cap choice cancelled";
				emit({ type: "human_confirmation_required", phase: "W3.5", reason });
				return { ok: false, results: allResults, statusReason: "human_confirmation", error: reason };
			}
			emit({ type: "pipeline_choice", phase: "W3.5", choiceId: capChoice, reason: "mission repair cap reached" });
			if (capChoice === "approve_to_w4") {
				statusReason = "user_override";
				knownIssues.push(`W3.5 mission repair cap overridden by user after ${maxMissionRepairLoops} loop(s)`);
				break;
			}
			if (capChoice !== "continue_repair") {
				const reason = `unsupported W3.5 cap choice: ${capChoice}`;
				emit({ type: "human_confirmation_required", phase: "W3.5", reason });
				return { ok: false, results: allResults, statusReason: "human_confirmation", error: reason };
			}
			maxMissionRepairLoops++;
			knownIssues.push(`W3.5 mission repair cap extended by user to ${maxMissionRepairLoops} loop(s)`);
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
			labelSuffix: ` repair ${missionLoopIndex}`,
			passId: `repair-${missionLoopIndex}`,
			artifactPaths,
			gateRetryKeys,
		});
		if (!repairPass.ok) return repairPass.result;
	}

	// ── W4: finalize + memory governance ──────────────────────────────────────
	emit({ type: "phase_start", phase: "W4", label: stageName("W4") });
	const candidates = await listCandidates(opts.projectRoot);
	let finalizeReport: FinalizeReport | undefined;
	try {
		const finalizeText = await opts.planner.finalize(allResults, candidates, memory.text);
		const fin = compileFinalize(finalizeText);
		if (fin.ok) {
			const epicTaskIds = resolvedContracts.map((c) => c.taskId);
			// NEW: fill planner omissions so durable candidates do not get stranded in staging.
			const memoryDecisions = withFallbackMemoryDecisions(fin.finalize.memoryDecisions, candidates);
			finalizeReport = await applyFinalize(opts.projectRoot, {
				...fin.finalize,
				memoryDecisions,
			}, candidates, {
				epicTaskIds,
			});
			emit({ type: "finalize_done", report: finalizeReport });
		} else {
			emit({ type: "pipeline_error", phase: "W4", error: fin.error });
		}
	} catch (e) {
		return fail(emit, "W4", e, allResults);
	}

	// Best-effort synthesis: compose a readable conclusion answering the goal.
	// A failure here must never sink an otherwise-complete pipeline.
	let conclusion: string | undefined;
	try {
		conclusion = extractConclusion(await opts.planner.synthesize(userRequest, allResults));
	} catch {
		conclusion = undefined;
	}

	const leafTaskIds = leafTaskIdsOf(resolvedContracts);
	const artifacts = [artifactPaths.dag, ...artifactPaths.contracts, ...artifactPaths.confirmations].filter(
		(p): p is string => Boolean(p),
	);

	emit({
		type: "pipeline_complete",
		results: allResults,
		goal: userRequest,
		...(conclusion && { conclusion }),
		...(leafTaskIds.length && { leafTaskIds }),
		...(artifacts.length && { artifacts }),
	});
	return { ok: true, results: allResults, statusReason, ...(finalizeReport && { finalize: finalizeReport }) };
}

function withFallbackMemoryDecisions(
	decisions: MergeDecision[],
	candidates: MemoryCandidate[],
): MergeDecision[] {
	const decidedIds = new Set(decisions.map((decision) => decision.candidateId));
	const fallback = candidates
		.filter((candidate) => candidate.body.trim().length > 0 && candidate.scope !== "none")
		.filter((candidate) => !decidedIds.has(`${candidate.sourceTask}.${candidate.persona}`))
		.map((candidate) => ({
			candidateId: `${candidate.sourceTask}.${candidate.persona}`,
			action: "merge" as const,
			target: defaultMemoryTargetForCandidate(candidate),
			section: defaultMemorySectionForCandidate(candidate),
			reason: "Deterministic fallback merged a staged candidate because W4 emitted no decision for it.",
		}));
	return fallback.length > 0 ? [...decisions, ...fallback] : decisions;
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
	gateRetryKeys: Set<string>;
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
		gateRetryKeys,
	} = args;

	// ── W1: perception ───────────────────────────────────────────────────────
	emit({ type: "phase_start", phase: "W1", label: stageLabel("W1", labelSuffix) });
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
	let allContracts: TaskContract[] = [];
	let refineErrors: ReturnType<typeof refineDag>["errors"] = [];
	let refineFeedback: string | undefined;
	let refineRetryUsed = false;
	let autoRefineRetryUsed = false;
	while (true) {
		const retryLabel = refineRetryUsed ? " retry" : autoRefineRetryUsed ? " auto retry" : "";
		emit({ type: "phase_start", phase: "W0.5", label: stageLabel("W0.5", labelSuffix, retryLabel) });
		const currentPassId = refineRetryUsed
			? `${passId}-refine-retry`
			: autoRefineRetryUsed
				? `${passId}-auto-refine-retry`
				: passId;
		let refinement: Map<string, RefinementEntry> = new Map();
		let refinementParsed = false;
		try {
			const refineText = await opts.planner.refine(dag, allResults, memoryText, opts.grantableCatalog, refineFeedback);
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
					currentPassId,
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
					currentPassId,
					refinement.values(),
				);
				artifactPaths.refinements.push(refinementPath);
				await refreshMemoryIndex(opts.projectRoot);
			} catch (e) {
				return { ok: false, result: fail(emit, "W0.5", e, allResults) };
			}
		}
		const refined = refineDag(dag, {
			inputs: baseInputs,
			refinement,
		});
		allContracts = refined.contracts;
		refineErrors = refined.errors;
		// Validate master grants against the catalog: record an error AND strip the
		// offending grant so an unknown/denied capability can never reach a worker.
		if (opts.grantableCatalog) {
			const cat = opts.grantableCatalog;
			const skillIds = new Set(cat.skills.map((s) => s.id));
			const toolNames = new Set(cat.mcpTools.map((t) => t.name));
			for (const c of allContracts) {
				const grantErrors = validateGrants(c, cat);
				if (grantErrors.length) {
					refineErrors.push({ taskId: c.taskId, errors: grantErrors });
					c.grantedSkills = c.grantedSkills.filter((id) => skillIds.has(id));
					c.grantedMcpTools = c.grantedMcpTools.filter((n) => toolNames.has(n));
				}
			}
		}
		const missingRefinementTaskIds = getMissingRefinementTaskIds(refineErrors);
		if (missingRefinementTaskIds.length > 0 && !autoRefineRetryUsed) {
			autoRefineRetryUsed = true;
			refineFeedback = [
				`Missing refinement entries: ${missingRefinementTaskIds.join(", ")}`,
				"The previous <refine> block is invalid. Every needs_refine task must have exactly one refinement entry.",
				"Re-emit the ENTIRE <refine> block, not an incremental patch.",
			].join("\n");
			emit({ type: "pipeline_choice", phase: "W0.5", choiceId: "auto_rerun_refine", reason: refineFeedback });
			continue;
		}
		if (refineErrors.length > 0) {
			for (const error of refineErrors) {
				knownIssues.push(`W0.5 ${error.taskId}: ${error.errors.join("; ")}`);
			}
		}
		try {
			const contractsPath = await writeContracts(opts.projectRoot, dag.epicId, currentPassId, allContracts, refineErrors);
			artifactPaths.contracts.push(contractsPath);
			const confirmation = buildDagConfirmation({
				userRequest: baseInputs.userGoal,
				dag,
				contracts: allContracts,
				refineErrors,
				results: allResults,
				knownIssues,
				passId: currentPassId,
			});
			const confirmationPath = await writeDagConfirmation(opts.projectRoot, dag.epicId, currentPassId, confirmation.markdown);
			artifactPaths.confirmations.push(confirmationPath);
			await refreshMemoryIndex(opts.projectRoot);
			emit({ type: "refine_done", contractCount: allContracts.length, errorCount: refineErrors.length });
			emit({
				type: "dag_confirmation_requested",
				phase: "W0.5",
				passId: currentPassId,
				brief: confirmation.brief,
				flow: confirmation.flow,
				artifactPath: confirmationPath,
			});
			const choice = await askPipelineChoice(opts.choiceGate, {
				question: "确认 DAG，进入 Build？",
				context: `${confirmation.brief}\n\n## DAG Flow\n${confirmation.flow}`,
				options: [
					{ id: "continue_w23", title: "继续 Build", summary: "确认 DAG，进入实现/验证。" },
					{ id: "rerun_refine", title: "重跑 Refine", summary: refineRetryUsed ? "已重跑过一次；再次选择会安全停止。" : "带反馈重新 refine。" },
					{ id: "stop_for_human", title: "暂停", summary: "安全停止，不发错误。" },
				],
				allowCustom: false,
			});
			if (!choice || choice === "stop_for_human") {
				const reason = choice ? "W0.5 DAG confirmation stopped for human review" : "W0.5 DAG confirmation cancelled";
				emit({ type: "human_confirmation_required", phase: "W0.5", reason });
				return { ok: false, result: { ok: false, results: allResults, statusReason: "human_confirmation", error: reason } };
			}
			emit({ type: "pipeline_choice", phase: "W0.5", choiceId: choice, reason: "dag confirmation" });
			if (choice === "continue_w23") break;
			if (choice === "rerun_refine" && !refineRetryUsed) {
				refineRetryUsed = true;
				refineFeedback = "User selected rerun_refine at the W0.5 DAG confirmation gate. Re-check task contracts, launchRequirements, blockedCondition, and downstream readiness.";
				continue;
			}
			const reason = choice === "rerun_refine" ? "W0.5 refine retry already used" : `unsupported W0.5 choice: ${choice}`;
			emit({ type: "human_confirmation_required", phase: "W0.5", reason });
			return { ok: false, result: { ok: false, results: allResults, statusReason: "human_confirmation", error: reason } };
		} catch (e) {
			return { ok: false, result: fail(emit, "W0.5", e, allResults) };
		}
	}
	resolvedContracts.push(...allContracts);

	// ── W2/3: implementation + validation (exclude perception, already run) ───
	emit({ type: "phase_start", phase: "W2/3", label: stageLabel("W2/3", labelSuffix) });
	const implContracts = allContracts.filter((c) => !PERCEPTION_PERSONAS.has(c.personaId));
	if (implContracts.length > 0) {
		try {
			const { runnable } = applyLaunchGate({
				contracts: implContracts,
				allResults,
				knownIssues,
				emit,
				gateRetryKeys,
			});
			const implResults = await runWaves(stripPerceptionDeps(runnable), opts, emit);
			allResults.push(...implResults);
			const retryResults = await retryBlockedContextGaps({
				results: implResults,
				contracts: runnable,
				opts,
				emit,
				knownIssues,
				gateRetryKeys,
			});
			allResults.push(...retryResults);
		} catch (e) {
			return { ok: false, result: fail(emit, "W2/3", e, allResults) };
		}
	}

	return { ok: true };
}

function getMissingRefinementTaskIds(errors: ReturnType<typeof refineDag>["errors"]): string[] {
	const missing = new Set<string>();
	for (const error of errors) {
		if (error.errors.some((message) => message.includes("needs_refine but has no refinement entry"))) {
			missing.add(error.taskId);
		}
	}
	return [...missing];
}

async function askPipelineChoice(
	choiceGate: ConfirmationGate | undefined,
	payload: ChoicePayload,
): Promise<string | undefined> {
	if (!choiceGate) return undefined;
	const verdict = await choiceGate.ask(payload);
	if (verdict.type !== "pick") return undefined;
	return verdict.optionId;
}

function buildDagConfirmation(args: {
	userRequest: string;
	dag: CoarseDag;
	contracts: TaskContract[];
	refineErrors: ReturnType<typeof refineDag>["errors"];
	results: TaskResult[];
	knownIssues: string[];
	passId: string;
}): { brief: string; flow: string; markdown: string } {
	const perception = args.results.filter((r) => PERCEPTION_PERSONAS.has(r.personaId));
	const launchRequirementCount = args.contracts.reduce((n, c) => n + (c.launchRequirements?.length ?? 0), 0);
	const runnable = args.contracts.filter((c) => !PERCEPTION_PERSONAS.has(c.personaId));
	const briefLines = [
		"# Refine DAG 确认",
		`目标: ${args.userRequest}`,
		`passId: ${args.passId}`,
		`Scan 感知结果: ${perception.length ? perception.map((r) => `${r.taskId}/${r.personaId}/${r.status}`).join(", ") : "无感知任务"}`,
		`Refine contracts: ${args.contracts.length} 个，预计 Build 启动: ${runnable.length} 个`,
		`launchRequirements: ${launchRequirementCount} 条`,
		`refine errors: ${args.refineErrors.length ? args.refineErrors.map((e) => `${e.taskId}: ${e.errors.join("; ")}`).join(" | ") : "无"}`,
		`known issues: ${args.knownIssues.length ? args.knownIssues.slice(-3).join(" | ") : "无"}`,
	];
	const flow = buildDagFlow(args.dag, args.contracts, args.refineErrors, args.results);
	const requirements = args.contracts.flatMap((contract) =>
		(contract.launchRequirements ?? []).map((r) => `- ${contract.taskId}: ${r.sourceTaskId}.${r.artifact}${r.required === false ? " (optional)" : ""}`),
	);
	const markdown = [
		...briefLines,
		"",
		"## DAG Flow",
		"```text",
		flow,
		"```",
		"",
		"## Launch Requirements",
		requirements.length ? requirements.join("\n") : "(none)",
		"",
		"## Contracts",
		args.contracts.map((c) => `- ${c.taskId} [${c.personaId}] dependsOn=${c.dependsOn.join(",") || "(none)"} blockedCondition=${c.blockedCondition ?? "(none)"}`).join("\n") || "(none)",
	].join("\n");
	return { brief: briefLines.join("\n"), flow, markdown };
}

function buildDagFlow(
	dag: CoarseDag,
	contracts: TaskContract[],
	refineErrors: ReturnType<typeof refineDag>["errors"],
	results: TaskResult[],
): string {
	const contractsById = new Map(contracts.map((c) => [c.taskId, c]));
	const errorIds = new Set(refineErrors.map((e) => e.taskId));
	const resultById = new Map(results.map((r) => [r.taskId, r]));
	const lines: string[] = [];
	for (const phase of dag.phases) {
		lines.push(`${phase.id} ${phase.name}`);
		for (const task of phase.tasks) {
			const contract = contractsById.get(task.id);
			const result = resultById.get(task.id);
			const status = errorIds.has(task.id)
				? "contract-error"
				: result
					? result.status === "ok" ? "ok" : result.status
					: contract?.launchRequirements?.length ? "deferred-risk" : "ready";
			const deps = task.dependsOn.length ? ` <- ${task.dependsOn.join(", ")}` : "";
			lines.push(`  [${status}] ${task.id} ${task.personaId}${deps}`);
			const objective = clipLine(contract?.objective ?? task.objective);
			if (objective) lines.push(`      objective: ${objective}`);
			const writes = contract?.pathPolicy?.allowedGlobs ?? [];
			if (writes.length) lines.push(`      writes: ${writes.join(", ")}`);
			const acceptance = contract?.acceptance ?? [];
			if (acceptance.length) lines.push(`      acceptance: ${clipLine(acceptance.join("; "))}`);
			if (contract?.launchRequirements?.length) {
				for (const req of contract.launchRequirements) {
					lines.push(`      requires ${req.sourceTaskId}.${req.artifact}`);
				}
			}
		}
	}
	return lines.join("\n");
}

function summarizeRawReport(raw: string): string {
	const trimmed = raw.replace(/\s+/g, " ").trim();
	return trimmed.length > 360 ? `${trimmed.slice(0, 360)}...` : trimmed;
}

/** Collapse to a single line and clip, so gate context stays readable. */
function clipLine(text: string | undefined, max = 140): string {
	if (!text) return "";
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function applyLaunchGate(args: {
	contracts: TaskContract[];
	allResults: TaskResult[];
	knownIssues: string[];
	emit: (e: PipelineEvent) => void;
	gateRetryKeys: Set<string>;
}): { runnable: TaskContract[] } {
	const { contracts, allResults, knownIssues, emit, gateRetryKeys } = args;
	const artifacts = buildArtifactMap(allResults);
	const runnable: TaskContract[] = [];
	const deferred = new Set<string>();

	for (const contract of contracts) {
		const deferredDep = contract.dependsOn.find((dep) => deferred.has(dep));
		if (deferredDep) {
			const reason = `${contract.taskId} deferred because dependency ${deferredDep} was deferred`;
			deferred.add(contract.taskId);
			knownIssues.push(`W2/3 ${reason}`);
			emit({ type: "task_deferred", phase: "W2/3", taskId: contract.taskId, reason, ...(contract.blockedCondition && { blockedCondition: contract.blockedCondition }) });
			continue;
		}

		const decision = evaluateLaunchGate(contract, allResults, artifacts);
		if (decision.ok) {
			runnable.push(contract);
			continue;
		}

		const reason = decision.issues.map((issue) => issue.reason).join("; ");
		if (!gateRetryKeys.has(contract.taskId)) {
			gateRetryKeys.add(contract.taskId);
			knownIssues.push(`W2/3 ${contract.taskId} launch gate missing context; allowing one same-contract retry: ${reason}`);
			emit({ type: "gate_retry", phase: "W2/3", taskId: contract.taskId, attempt: 1, reason });
			runnable.push(contract);
			continue;
		}

		deferred.add(contract.taskId);
		knownIssues.push(`W2/3 ${contract.taskId} deferred after one same-contract retry: ${reason}`);
		emit({ type: "task_deferred", phase: "W2/3", taskId: contract.taskId, reason, ...(contract.blockedCondition && { blockedCondition: contract.blockedCondition }) });
	}

	return { runnable };
}

async function retryBlockedContextGaps(args: {
	results: TaskResult[];
	contracts: TaskContract[];
	opts: PipelineOptions;
	emit: (e: PipelineEvent) => void;
	knownIssues: string[];
	gateRetryKeys: Set<string>;
}): Promise<TaskResult[]> {
	const { results, contracts, opts, emit, knownIssues, gateRetryKeys } = args;
	const byId = new Map(contracts.map((c) => [c.taskId, c]));
	const retryContracts: TaskContract[] = [];

	for (const result of results) {
		if (!isContextGapBlocked(result)) continue;
		const contract = byId.get(result.taskId);
		if (!contract) continue;
		if (gateRetryKeys.has(result.taskId)) {
			const reason = `${result.taskId} remained blocked after one same-contract context retry`;
			knownIssues.push(`W2/3 ${reason}`);
			emit({ type: "task_deferred", phase: "W2/3", taskId: result.taskId, reason, ...(contract.blockedCondition && { blockedCondition: contract.blockedCondition }) });
			continue;
		}
		gateRetryKeys.add(result.taskId);
		const reason = `${result.taskId} returned blocked for missing W1 context`;
		knownIssues.push(`W2/3 ${reason}; allowing one same-contract retry`);
		emit({ type: "gate_retry", phase: "W2/3", taskId: result.taskId, attempt: 1, reason });
		retryContracts.push(contract);
	}

	if (retryContracts.length === 0) return [];
	const retryResults = await runWaves(stripPerceptionDeps(retryContracts), opts, emit);
	for (const result of retryResults) {
		if (!isContextGapBlocked(result)) continue;
		const contract = byId.get(result.taskId);
		const reason = `${result.taskId} remained blocked after one same-contract context retry`;
		knownIssues.push(`W2/3 ${reason}`);
		emit({ type: "task_deferred", phase: "W2/3", taskId: result.taskId, reason, ...(contract?.blockedCondition && { blockedCondition: contract.blockedCondition }) });
	}
	return retryResults;
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
	return { ok: false, results, error, statusReason: "error" };
}
