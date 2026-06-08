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
	MemoryIndexRefreshScheduler,
	type FinalizeReport,
} from "../memory/governance/index.js";
import type { MemoryCandidate, MergeDecision } from "../memory/governance/types.js";
import type { PersonaId } from "../personas/Persona.js";
import { getPersona } from "../personas/PersonaRegistry.js";
import { compileCoarse, classifyTaskType } from "./TaskCompiler.js";
import type { CoarseDag, TaskContract, TaskInputs } from "./TaskContract.js";
import { DynamicHarness } from "./DynamicHarness.js";
import { decideMissionCheckMode } from "./MissionCheckMode.js";
import { classifyOrchestrationMode, type OrchestrationMode } from "./OrchestrationClassifier.js";
import type { PipelineCache } from "./PipelineCache.js";
import { compileRefinement, refineDag, type RefinementEntry } from "./Refiner.js";
import { validateGrants, type GrantableCatalog } from "./CapabilityCatalog.js";
import { buildArtifactMap, canUseReadonlyFallback, evaluateLaunchGate, isContextGapBlocked } from "./LaunchGate.js";
import { compilePlanAudit, extractExecutionPlan, needsPlanApproval, type PlanMode } from "./PlanGate.js";
import { classifyRoutePolicy, type RouteHint, type RoutePolicy } from "./RoutePolicy.js";
import { validateAgainstRoutePolicy } from "./RoutePolicyValidator.js";
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
import { stageLabel, stageName } from "./StageDisplay.js";
import { extractXmlBlock, type TaskResult, type TaskRunnerOptions, type WorkerExecutor } from "./TaskRunner.js";
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

const READONLY_FALLBACK_GRANTED_TOOLS = [
	"shell_fs_read",
	"shell_search",
	"shell_git_read",
] as const;

export type PipelinePhase = "W0" | "W1" | "W0.5" | "W2/3" | "W3.5" | "W4";

/**
 * WaveEvent — progress-event shape consumed by the TUI pipeline panel. The
 * dynamic harness adapter ({@link runDag}) emits the `task_start` / `task_done`
 * variants; the remaining variants are retained as a stable wire format for the
 * TUI translator (`PipelineBridge.translateWaveEvent`).
 */
export type WaveEvent =
	| { type: "wave_start"; waveIndex: number; taskCount: number }
	| { type: "task_start"; waveIndex: number; taskId: string }
	| { type: "task_done"; waveIndex: number; result: TaskResult }
	| { type: "wave_complete"; waveIndex: number; results: TaskResult[] }
	| { type: "stage_pause"; waveIndex: number; reason: string }
	| { type: "schedule_complete"; allResults: TaskResult[] };

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
	| { type: "plan_proposed"; phase: "W2/3"; taskId: string; persona: PersonaId }
	| { type: "plan_audited"; phase: "W2/3"; taskId: string; decision: "APPROVED" | "REVISE" | "blocked"; reason: string }
	| { type: "plan_revise"; phase: "W2/3"; taskId: string; attempt: number; corrections: string[] }
	| { type: "finalize_done"; report: FinalizeReport }
	| {
			type: "pipeline_complete";
			results: TaskResult[];
			/** Original user goal, echoed so the summary can restate it. */
			goal?: string;
			/** W4 master_planner-authored final delivery brief. */
			finalBrief?: string;
			/** Business files changed by the run, excluding internal process artifacts. */
			changedFiles?: string[];
			/** Internal process artifacts for debug/trace surfaces only. */
			traceArtifacts?: string[];
			/** W4 human-readable conclusion answering the goal (from synthesize). */
			conclusion?: string;
			/** Terminal task ids (nothing depends on them) — the actual deliverables. */
			leafTaskIds?: string[];
			/** Persisted artifact file paths produced by the run. */
			artifacts?: string[];
	  }
	| { type: "pipeline_error"; phase: PipelinePhase; error: string };

export type PipelineStatusReason = "human_confirmation" | "user_override" | "complete" | "error";

export interface FinalDeliveryInput {
	userRequest: string;
	statusReason: PipelineStatusReason;
	results: TaskResult[];
	leafTaskIds: string[];
	knownIssues: string[];
	finalizeReport?: FinalizeReport;
	writtenFilesByTask?: Array<{ taskId: string; files: string[] }>;
}

/** Input for the W2-plan audit touchpoint. */
export interface PlanAuditInput {
	taskId: string;
	persona: PersonaId;
	objective: string;
	allowedGlobs: string[];
	acceptance: string[];
	nonGoals: string[];
	/** The worker's proposed <execution_plan> body. */
	plan: string;
	/** Compact summary of upstream artifacts (file_list, relevant_files, …). */
	upstreamArtifacts: string;
}

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
	/** W2-plan: audit a worker's proposed execution plan; returns text with a
	 *  <plan_audit> block (APPROVED / REVISE + corrections). Optional — required
	 *  only when planMode is enabled. */
	auditPlan?(input: PlanAuditInput): Promise<string>;
	/** W4: returns master output containing a <finalize> block. */
	finalize(
		results: TaskResult[],
		candidates: MemoryCandidate[],
		canonicalText: string,
	): Promise<string>;
	/** Post-W4: master_planner-authored final delivery brief. */
	deliver(input: FinalDeliveryInput): Promise<string>;
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

/** Pull the Markdown body out of a <final_brief> block, or undefined if absent/empty. */
export function extractFinalBrief(text: string): string | undefined {
	const m = /<final_brief>([\s\S]*?)<\/final_brief>/i.exec(text);
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
	/** Business-file writes observed by the caller and forwarded into W4 delivery. */
	getDeliveryWrites?: () => Array<{ taskId: string; files: string[] }>;
	/** Force full W3.5 mission check even when a lighter mode would suffice. */
	forceMissionCheck?: boolean;
	/** Override the automatic orchestration mode classification. */
	orchestrationMode?: OrchestrationMode;
	/** Optional route/fan-out hints; explicit hints override automatic route policy classification. */
	routeHint?: RouteHint;
	/** Fully resolved route policy, usually built by PipelineBridge from the clean user request. */
	routePolicy?: RoutePolicy;
	/** In-run cache for file reads and command results to avoid redundant I/O. */
	cache?: PipelineCache;
	/**
	 * W2-plan gate: when a write task runs, the worker first proposes an
	 * <execution_plan> that master_planner audits before execution.
	 *   • "off"            — disabled (default; behaviour unchanged)
	 *   • "code_personas"  — code_executor + test_writer write tasks
	 *   • "all_writes"     — every write-capable task
	 */
	planMode?: PlanMode;
	/** Max plan REVISE rounds before the task is blocked. Defaults to 2. */
	maxPlanRevisions?: number;
	retryBackoff?: TaskRunnerOptions["retryBackoff"];
}

export interface PipelineResult {
	ok: boolean;
	results: TaskResult[];
	finalize?: FinalizeReport;
	error?: string;
	statusReason?: PipelineStatusReason;
	finalBrief?: string;
	leafTaskIds?: string[];
	changedFiles?: string[];
}

export async function runPipeline(
	userRequest: string,
	opts: PipelineOptions,
): Promise<PipelineResult> {
	const emit = opts.onEvent ?? (() => {});
	const routePolicy = opts.routePolicy ?? classifyRoutePolicy(userRequest, opts.routeHint);
	opts.routePolicy = routePolicy;
	const orchestrationMode = opts.orchestrationMode ?? orchestrationModeForRoutePolicy(routePolicy, userRequest);

	if (orchestrationMode === "scan_only") {
		return runScanOnly(userRequest, opts, emit);
	}
	if (orchestrationMode === "direct_edit") {
		return runDirectEdit(userRequest, opts, emit);
	}

	const taskType = classifyTaskType(userRequest);
	const allResults: TaskResult[] = [];
	const resolvedContracts: TaskContract[] = [];
	const refinements: RefinementEntry[] = [];
	const knownIssues: string[] = [];
	const gateRetryKeys = new Set<string>();
	const artifactPaths = emptyArtifactPaths();
	artifactPaths.memoryIndex = memoryIndexPath(opts.projectRoot);
	const refreshScheduler = new MemoryIndexRefreshScheduler();
	let maxMissionRepairLoops = opts.maxMissionRepairLoops ?? DEFAULT_MAX_MISSION_REPAIR_LOOPS;
	let statusReason: PipelineStatusReason = "complete";

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
		refreshScheduler.markDirty("W0:writeDag");
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
		refreshScheduler,
	});
	if (!initialPass.ok) return initialPass.result;

	const deliveryWrites = opts.getDeliveryWrites?.();
	const writtenByTask = normalizeWrittenFilesByTask(deliveryWrites);
	const preCheckChangedFiles = collectChangedFiles(writtenByTask);
	const hasFileChanges = deliveryWrites === undefined ? true : preCheckChangedFiles.length > 0;
	const allPersonasReadOnly = dag.phases.every((phase) =>
		phase.tasks.every((task) => {
			try { return !getPersona(task.personaId).pathPolicy.canWrite; }
			catch { return true; }
		}),
	);
	const testsPassed = allResults.some(
		(r) => r.personaId === "test_runner" && r.status === "ok",
	);
	const missionMode = decideMissionCheckMode({
		hasFileChanges,
		isReadOnlyTask: allPersonasReadOnly,
		changedFiles: preCheckChangedFiles,
		testsPassed,
		userRequestedFullCheck: opts.forceMissionCheck ?? false,
	});

	if (missionMode === "skip") {
		emit({ type: "phase_start", phase: "W3.5", label: stageName("W3.5") });
		emit({ type: "phase_skip" as any, phase: "W3.5", reason: preCheckChangedFiles.length === 0 ? "no file changes" : "read-only task" });
	} else {

	let missionLoopIndex = 0;
	while (true) {
		emit({ type: "phase_start", phase: "W3.5", label: stageName("W3.5") });
		let missionText: string;
		let missionFeedback: string | undefined;
		let missionAutoRetryUsed = false;
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
				attempt: missionAutoRetryUsed || missionParseRetryUsed ? 2 : 1,
			});
			// Automatic targeted re-emit before involving the human: hand the
			// parser error + raw excerpt back so the checker can complete the
			// missing module (a legal Decision line / usable loop-back tasks).
			if (!missionAutoRetryUsed) {
				missionAutoRetryUsed = true;
				missionFeedback = `${mission.error}\nRaw report excerpt:\n${rawExcerpt || "(empty)"}`;
				emit({ type: "pipeline_choice", phase: "W3.5", choiceId: "auto_rerun_mission", reason: mission.error });
				continue;
			}
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
			refreshScheduler.markDirty("W3.5:missionCheck");
		} catch (e) {
			return fail(emit, "W3.5", e, allResults);
		}

		if (mission.report.decision === "APPROVED_TO_W4") {
			break;
		}
		if (mission.report.decision === "NEEDS_HUMAN_CONFIRMATION") {
			const reason = `mission checker requires human confirmation${mission.report.reason ? `: ${mission.report.reason}` : ""}`;
			emit({ type: "human_confirmation_required", phase: "W3.5", reason });
			const choice = await askPipelineChoice(opts.choiceGate, {
				question: "Accept 需要人工确认，如何继续？",
				context: mission.report.reason ?? undefined,
				options: [
					{ id: "stop_for_human", title: "暂停", summary: "安全停止，等待人工审查。" },
					{ id: "approve_to_w4", title: "推进到 Finalize", summary: "用户 override，跳过确认直接进入 W4。" },
				],
				allowCustom: false,
			});
			if (!choice || choice === "stop_for_human") {
				return { ok: false, results: allResults, statusReason: "human_confirmation", error: reason };
			}
			emit({ type: "pipeline_choice", phase: "W3.5", choiceId: choice, reason: "needs_human_confirmation override" });
			if (choice === "approve_to_w4") {
				statusReason = "user_override";
				knownIssues.push(`W3.5 NEEDS_HUMAN_CONFIRMATION overridden by user: ${reason}`);
				break;
			}
			const unsupported = `unsupported W3.5 human confirmation choice: ${choice}`;
			return { ok: false, results: allResults, statusReason: "human_confirmation", error: unsupported };
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
			refreshScheduler.markDirty("W3.5:repairDag");
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
			refreshScheduler,
		});
		if (!repairPass.ok) return repairPass.result;
	}

	} // end missionMode !== "skip"

	// ── W4: finalize + memory governance ──────────────────────────────────────
	await refreshScheduler.flushIfDirty(opts.projectRoot);
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

	const leafTaskIds = leafTaskIdsOf(resolvedContracts);
	const traceArtifacts = [artifactPaths.dag, ...artifactPaths.contracts, ...artifactPaths.confirmations].filter(
		(p): p is string => Boolean(p),
	);
	const writtenFilesByTask = normalizeWrittenFilesByTask(opts.getDeliveryWrites?.());
	const changedFiles = collectChangedFiles(writtenFilesByTask);

	// Best-effort final delivery: compose the user-facing brief without exposing
	// internal process artifacts by default. Delivery failures must never sink
	// an otherwise-complete pipeline.
	let finalBrief: string | undefined;
	try {
		finalBrief = extractFinalBrief(
			await opts.planner.deliver({
				userRequest,
				statusReason,
				results: allResults,
				leafTaskIds,
				knownIssues,
				...(finalizeReport && { finalizeReport }),
				...(writtenFilesByTask.length && { writtenFilesByTask }),
			}),
		);
	} catch {
		finalBrief = undefined;
	}

	await refreshScheduler.flushIfDirty(opts.projectRoot);

	emit({
		type: "pipeline_complete",
		results: allResults,
		goal: userRequest,
		...(finalBrief && { finalBrief }),
		...(leafTaskIds.length && { leafTaskIds }),
		...(changedFiles.length && { changedFiles }),
		...(traceArtifacts.length && { traceArtifacts }),
	});
	return {
		ok: true,
		results: allResults,
		statusReason,
		...(finalizeReport && { finalize: finalizeReport }),
		...(finalBrief && { finalBrief }),
		...(leafTaskIds.length && { leafTaskIds }),
		...(changedFiles.length && { changedFiles }),
	};
}

function orchestrationModeForRoutePolicy(routePolicy: RoutePolicy, userRequest: string): OrchestrationMode {
	if (routePolicy.route === "scan_only") return "scan_only";
	if (routePolicy.route === "direct_edit") return "direct_edit";
	if (routePolicy.route === "full_pipeline") return classifyOrchestrationMode(userRequest);
	return "full_pipeline";
}

async function runScanOnly(
	userRequest: string,
	opts: PipelineOptions,
	emit: (e: PipelineEvent) => void,
): Promise<PipelineResult> {
	const allResults: TaskResult[] = [];
	const artifactPaths = emptyArtifactPaths();

	emit({ type: "phase_start", phase: "W1", label: stageName("W1") });
	const memory = await loadCanonicalMemory(opts.projectRoot, "general");
	const baseInputs: TaskInputs = { userGoal: userRequest, artifacts: [], constraints: [] };

	const scoutContract: TaskContract = {
		taskId: "scan-1",
		phase: "P1",
		epicId: "scan-only",
		personaId: "repo_scout",
		objective: userRequest,
		inputs: baseInputs,
		pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		acceptance: [],
		outputSchema: getPersona("repo_scout").outputSchema,
		parallelGroup: "P1-scan",
		dependsOn: [],
		grantedSkills: [],
		grantedMcpTools: [],
		abortOnConflict: false,
	};

	try {
		const results = await runDag([scoutContract], opts, emit);
		allResults.push(...results);
	} catch (e) {
		return fail(emit, "W1", e, allResults);
	}

	let finalBrief: string | undefined;
	try {
		finalBrief = extractFinalBrief(
			await opts.planner.deliver({
				userRequest,
				statusReason: "complete",
				results: allResults,
				leafTaskIds: ["scan-1"],
				knownIssues: [],
			}),
		);
	} catch {
		finalBrief = undefined;
	}

	emit({
		type: "pipeline_complete",
		results: allResults,
		goal: userRequest,
		...(finalBrief && { finalBrief }),
		leafTaskIds: ["scan-1"],
	});
	return {
		ok: true,
		results: allResults,
		statusReason: "complete",
		...(finalBrief && { finalBrief }),
		leafTaskIds: ["scan-1"],
	};
}

async function runDirectEdit(
	userRequest: string,
	opts: PipelineOptions,
	emit: (e: PipelineEvent) => void,
): Promise<PipelineResult> {
	const allResults: TaskResult[] = [];
	const refreshScheduler = new MemoryIndexRefreshScheduler();

	emit({ type: "phase_start", phase: "W1", label: stageName("W1") });
	const memory = await loadCanonicalMemory(opts.projectRoot, "general");
	const baseInputs: TaskInputs = { userGoal: userRequest, artifacts: [], constraints: [] };

	const perceptionDag: CoarseDag = {
		epicId: "direct-edit",
		phases: [{
			id: "P1",
			name: "perception",
		tasks: [{
			id: "scout-1",
			personaId: "repo_scout",
			objective: userRequest,
			parallelGroup: "P1-scout",
			dependsOn: [],
			needsRefine: false,
			allowedGlobs: [],
			acceptance: [],
		}],
		}],
	};
	const { contracts: perceptionContracts } = refineDag(perceptionDag, {
		inputs: baseInputs,
		refinement: new Map(),
	});
	if (perceptionContracts.length > 0) {
		try {
			const results = await runDag(perceptionContracts, opts, emit);
			allResults.push(...results);
		} catch (e) {
			return fail(emit, "W1", e, allResults);
		}
	}

	emit({ type: "phase_start", phase: "W2/3", label: stageName("W2/3") });
	const editContract: TaskContract = {
		taskId: "edit-1",
		phase: "P2",
		epicId: "direct-edit",
		personaId: "code_executor",
		objective: userRequest,
		inputs: baseInputs,
		pathPolicy: { allowedGlobs: ["**"], forbiddenGlobs: [] },
		acceptance: [],
		outputSchema: getPersona("code_executor").outputSchema,
		parallelGroup: "P2-edit",
		dependsOn: ["scout-1"],
		grantedSkills: [],
		grantedMcpTools: [],
		abortOnConflict: false,
	};
	try {
		const results = await runDag([editContract], opts, emit, refreshScheduler);
		allResults.push(...results);
	} catch (e) {
		return fail(emit, "W2/3", e, allResults);
	}

	await refreshScheduler.flushIfDirty(opts.projectRoot);

	let finalBrief: string | undefined;
	try {
		finalBrief = extractFinalBrief(
			await opts.planner.deliver({
				userRequest,
				statusReason: "complete",
				results: allResults,
				leafTaskIds: ["edit-1"],
				knownIssues: [],
			}),
		);
	} catch {
		finalBrief = undefined;
	}

	const writtenFilesByTask = normalizeWrittenFilesByTask(opts.getDeliveryWrites?.());
	const changedFiles = collectChangedFiles(writtenFilesByTask);

	emit({
		type: "pipeline_complete",
		results: allResults,
		goal: userRequest,
		...(finalBrief && { finalBrief }),
		leafTaskIds: ["edit-1"],
		...(changedFiles.length && { changedFiles }),
	});
	return {
		ok: true,
		results: allResults,
		statusReason: "complete",
		...(finalBrief && { finalBrief }),
		leafTaskIds: ["edit-1"],
		...(changedFiles.length && { changedFiles }),
	};
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
	refreshScheduler: MemoryIndexRefreshScheduler;
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
			const perceptionResults = await runDag(perceptionContracts, opts, emit, args.refreshScheduler);
			allResults.push(...perceptionResults);
		} catch (e) {
			return { ok: false, result: fail(emit, "W1", e, allResults) };
		}
	}
	const staticCompileCommands = await resolveStaticCompileCommands(opts.projectRoot, allResults);
	const effectiveInputs: TaskInputs = {
		...baseInputs,
		...(staticCompileCommands.length > 0 && { staticCompileCommands }),
	};
	const routePolicy = opts.routePolicy ?? classifyRoutePolicy(baseInputs.userGoal, opts.routeHint);

	// ── W0.5: refine ──────────────────────────────────────────────────────────
	let allContracts: TaskContract[] = [];
	let refineErrors: ReturnType<typeof refineDag>["errors"] = [];
	let refineFeedback: string | undefined;
	let refineRetryUsed = false;
	let autoRefineRounds = 0;
	const MAX_AUTO_REFINE_ROUNDS = 2;
	while (true) {
		const retryLabel = refineRetryUsed ? " retry" : autoRefineRounds > 0 ? " auto retry" : "";
		emit({ type: "phase_start", phase: "W0.5", label: stageLabel("W0.5", labelSuffix, retryLabel) });
		const currentPassId = refineRetryUsed
			? `${passId}-refine-retry`
			: autoRefineRounds > 0
				? `${passId}-auto-refine-retry-${autoRefineRounds}`
				: passId;
		let refinement: Map<string, RefinementEntry> = new Map();
		let refinementParsed = false;
		try {
			const refineText = await opts.planner.refine(dag, allResults, memoryText, opts.grantableCatalog, refineFeedback);
			const parsed = compileRefinement(refineText);
			if (parsed.ok) {
				refinement = parsed.entries;
				refinementParsed = true;
				await writeInlineContextPacks(opts.projectRoot, dag.epicId, refinement, args.refreshScheduler);
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
				args.refreshScheduler.markDirty("W0.5:failedRefine");
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
				args.refreshScheduler.markDirty("W0.5:refine");
			} catch (e) {
				return { ok: false, result: fail(emit, "W0.5", e, allResults) };
			}
		}
		const refined = refineDag(dag, {
			inputs: effectiveInputs,
			refinement,
		});
		allContracts = refined.contracts;
		refineErrors = refined.errors;
		const routePolicyIssues = validateAgainstRoutePolicy({ routePolicy, contracts: allContracts, dag });
		if (routePolicyIssues.length > 0 && autoRefineRounds < MAX_AUTO_REFINE_ROUNDS) {
			autoRefineRounds++;
			refineFeedback = [
				"# coarse-task-risk",
				...routePolicyIssues.map((issue) => `- ${issue.code}${issue.taskId ? ` (${issue.taskId})` : ""}: ${issue.message}`),
				"",
				"Re-emit the ENTIRE <refine> block preserving task ids where possible. For audit_review, split broad reviewers by finding domain or bounded file cluster, avoid one global scout file_list gate, and make docs depend on reviewer task reports.",
			].join("\n");
			emit({ type: "pipeline_choice", phase: "W0.5", choiceId: "auto_rerun_refine", reason: "coarse-task-risk" });
			continue;
		}
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
		// Validate-and-repair gate: when the refine block produced contracts with
		// repairable errors (missing allowedGlobs / blockedCondition / nonGoals,
		// glob conflicts, missing entries, bad grants), re-prompt the planner with
		// targeted per-task feedback to re-emit the specific modules before passing
		// the contracts to Build — rather than letting an invalid contract die later
		// as contract_invalid. Capped at MAX_AUTO_REFINE_ROUNDS; remaining errors
		// fall through to the human confirmation gate below.
		const refineRepair = buildRefineRepairFeedback(refineErrors);
		if (refineRepair && autoRefineRounds < MAX_AUTO_REFINE_ROUNDS) {
			autoRefineRounds++;
			refineFeedback = refineRepair.feedback;
			emit({ type: "pipeline_choice", phase: "W0.5", choiceId: "auto_rerun_refine", reason: refineRepair.reason });
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
				staticCompileCommands,
				dag,
				contracts: allContracts,
				refineErrors,
				results: allResults,
				knownIssues,
				passId: currentPassId,
			});
			const confirmationPath = await writeDagConfirmation(opts.projectRoot, dag.epicId, currentPassId, confirmation.markdown);
			artifactPaths.confirmations.push(confirmationPath);
			await args.refreshScheduler.flushIfDirty(opts.projectRoot);
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
				context: buildDagChoiceContext({
					userRequest: baseInputs.userGoal,
					passId: currentPassId,
					dag,
					contracts: allContracts,
					refineErrors,
					knownIssues,
					artifactPath: confirmationPath,
				}),
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
			// W2-plan gate: write tasks propose a plan that master_planner audits
			// before execution. Returns approved contracts (with inputs.approvedPlan);
			// rejected ones are dropped and recorded as blocked.
			const planned = await runPlanGate({
				contracts: runnable,
				allResults,
				opts,
				emit,
				knownIssues,
			});
			const implResults = await runDag(stripPerceptionDeps(planned), opts, emit, args.refreshScheduler);
			allResults.push(...implResults);
			const retryResults = await retryBlockedContextGaps({
				results: implResults,
				contracts: runnable,
				opts,
				emit,
				knownIssues,
				gateRetryKeys,
				refreshScheduler: args.refreshScheduler,
			});
			allResults.push(...retryResults);
		} catch (e) {
			return { ok: false, result: fail(emit, "W2/3", e, allResults) };
		}
	}

	return { ok: true };
}

interface RefineRepair {
	/** Targeted re-emit instructions handed back to the planner. */
	feedback: string;
	/** Short summary for the auto_rerun_refine pipeline_choice event. */
	reason: string;
}

/**
 * Classify refine/contract validation errors into the subset that the planner
 * can fix by re-emitting the <refine> block, and build targeted feedback that
 * names the exact task + field to complete. Returns undefined when nothing is
 * refine-repairable (e.g. coarse-DAG-level problems), so the caller proceeds to
 * the human confirmation gate instead of looping.
 */
function buildRefineRepairFeedback(
	errors: ReturnType<typeof refineDag>["errors"],
): RefineRepair | undefined {
	const missingEntries = new Set<string>();
	const missingGlobs = new Set<string>();
	const missingBlocked = new Set<string>();
	const missingNonGoals = new Set<string>();
	const globConflicts: string[] = [];
	const grantIssues: string[] = [];

	for (const entry of errors) {
		for (const message of entry.errors) {
			if (message.includes("needs_refine but has no refinement entry")) {
				missingEntries.add(entry.taskId);
			} else if (message.includes("requires allowedGlobs")) {
				missingGlobs.add(entry.taskId);
			} else if (message.includes("blockedCondition must be at least 8 characters")) {
				// Hard contract_invalid only — the Refiner's "requires explicit
				// blockedCondition" nudge still yields a valid (defaulted) contract,
				// so it is not worth a re-prompt round.
				missingBlocked.add(entry.taskId);
			} else if (message.includes("nonGoals must be a non-empty array")) {
				missingNonGoals.add(entry.taskId);
			} else if (entry.taskId === "_glob_conflict") {
				globConflicts.push(message);
			} else if (message.includes("is not in the grantable catalog")) {
				grantIssues.push(message);
			}
		}
	}

	const lines: string[] = [];
	if (missingEntries.size > 0) {
		lines.push(`Missing refinement entries: ${[...missingEntries].join(", ")}`);
	}
	if (missingGlobs.size > 0) {
		lines.push(
			`Tasks missing allowedGlobs (provide a non-empty allowedGlobs array scoping each task's writable files): ${[...missingGlobs].join(", ")}`,
		);
	}
	if (missingBlocked.size > 0) {
		lines.push(
			`Tasks missing a valid blockedCondition (provide a >=8 character condition describing when the task should stop): ${[...missingBlocked].join(", ")}`,
		);
	}
	if (missingNonGoals.size > 0) {
		lines.push(
			`Tasks missing nonGoals (provide a non-empty nonGoals array of explicit out-of-scope boundaries): ${[...missingNonGoals].join(", ")}`,
		);
	}
	if (globConflicts.length > 0) {
		lines.push(
			`Glob conflicts — give the listed tasks disjoint allowedGlobs:\n${globConflicts.map((c) => `  - ${c}`).join("\n")}`,
		);
	}
	if (grantIssues.length > 0) {
		lines.push(
			`Capability grant issues — only grant skills/tools present in the grantable catalog:\n${grantIssues.map((g) => `  - ${g}`).join("\n")}`,
		);
	}

	if (lines.length === 0) return undefined;

	const reasonParts = [
		missingEntries.size ? `${missingEntries.size} missing entr${missingEntries.size === 1 ? "y" : "ies"}` : "",
		missingGlobs.size ? `${missingGlobs.size} missing allowedGlobs` : "",
		missingBlocked.size ? `${missingBlocked.size} missing blockedCondition` : "",
		missingNonGoals.size ? `${missingNonGoals.size} missing nonGoals` : "",
		globConflicts.length ? `${globConflicts.length} glob conflict(s)` : "",
		grantIssues.length ? `${grantIssues.length} grant issue(s)` : "",
	].filter(Boolean);

	return {
		feedback: [
			"The previous <refine> block produced invalid task contracts. Re-emit the ENTIRE <refine> block (not an incremental patch) with every issue below fixed. Every needs_refine task must have exactly one entry.",
			"",
			...lines,
		].join("\n"),
		reason: reasonParts.join(", "),
	};
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
	staticCompileCommands: string[];
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
		`static compile: ${args.staticCompileCommands.length ? args.staticCompileCommands.join(" ; ") : "none"}`,
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

/**
 * Build a compressed "decision summary card" for the W0.5 ask_choice context.
 * Full DAG flow is written to artifact; this returns only the actionable info
 * a user needs to decide continue / rerun / pause.
 */
function buildDagChoiceContext(args: {
	userRequest: string;
	passId: string;
	dag: CoarseDag;
	contracts: TaskContract[];
	refineErrors: ReturnType<typeof refineDag>["errors"];
	knownIssues: string[];
	artifactPath: string;
}): string {
	const errorById = new Map(args.refineErrors.map((e) => [e.taskId, e.errors]));
	const runnable = args.contracts.filter((c) => !PERCEPTION_PERSONAS.has(c.personaId));
	const deferred = args.contracts.filter((c) => (c.launchRequirements?.length ?? 0) > 0);
	const writers = runnable.filter((c) => c.pathPolicy.allowedGlobs.length > 0);

	const lines: string[] = [
		"# Refine DAG confirmation",
		`Goal: ${clipLine(args.userRequest, 120)}`,
		`passId: ${args.passId}`,
		"",
		"## Summary",
		`contracts: ${args.contracts.length}`,
		`runnable Build tasks: ${runnable.length}`,
		`contract errors: ${args.refineErrors.length}`,
		`deferred-risk tasks: ${deferred.length}`,
		`write-capable tasks: ${writers.length}`,
		"",
		"## Build candidates",
	];

	for (const c of runnable.slice(0, 8)) {
		const errors = errorById.get(c.taskId);
		const status = errors ? "!" : c.launchRequirements?.length ? "?" : "✓";
		const writes = c.pathPolicy.allowedGlobs.length
			? ` writes: ${c.pathPolicy.allowedGlobs.join(", ")}`
			: "";
		const deps = c.dependsOn.length ? ` deps: ${c.dependsOn.join(", ")}` : "";
		lines.push(`  ${status} ${c.taskId} ${c.personaId}${deps}${writes}`);
	}

	if (runnable.length > 8) {
		lines.push(`  … ${runnable.length - 8} more task(s), see artifact`);
	}

	if (args.refineErrors.length || args.knownIssues.length) {
		lines.push("", "## Risks");
		for (const e of args.refineErrors.slice(0, 5)) {
			lines.push(`  ! ${e.taskId}: ${clipLine(e.errors.join("; "), 140)}`);
		}
		for (const issue of args.knownIssues.slice(-3)) {
			lines.push(`  ! ${clipLine(issue, 140)}`);
		}
	}

	lines.push("", "## Full DAG");
	lines.push(`  ${args.artifactPath}`);

	return lines.join("\n");
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

type StaticCompileCandidate = {
	command: string;
	source?: string;
	confidence: "high" | "medium" | "low";
};

async function resolveStaticCompileCommands(
	projectRoot: string,
	results: TaskResult[],
): Promise<string[]> {
	const observed = selectObservedStaticCompileCommands(results);
	if (observed.length > 0) return observed;
	return detectStaticCompileCommands(projectRoot);
}

function selectObservedStaticCompileCommands(results: TaskResult[]): string[] {
	const candidates = results
		.filter((result) => result.personaId === "repo_scout" && result.status === "ok")
		.flatMap((result) => parseStaticCompileCommands(result.report));
	if (candidates.length === 0) return [];
	const rank = { high: 3, medium: 2, low: 1 };
	const best = Math.max(...candidates.map((candidate) => rank[candidate.confidence]));
	return [...new Set(candidates.filter((candidate) => rank[candidate.confidence] === best).map((candidate) => candidate.command))];
}

function parseStaticCompileCommands(report: string): StaticCompileCandidate[] {
	const body = extractXmlBlock(report, "static_compile_commands");
	if (!body) return [];
	const commands: StaticCompileCandidate[] = [];
	let current: StaticCompileCandidate | undefined;
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trimEnd();
		const commandMatch = /^\s*-\s*command:\s*(.+)$/.exec(line);
		if (commandMatch) {
			if (current?.command) commands.push(current);
			current = { command: commandMatch[1]!.trim(), confidence: "medium" };
			continue;
		}
		if (!current) continue;
		const sourceMatch = /^\s*source:\s*(.+)$/.exec(line.trim());
		if (sourceMatch) {
			current.source = sourceMatch[1]!.trim();
			continue;
		}
		const confidenceMatch = /^\s*confidence:\s*(high|medium|low)\s*$/i.exec(line.trim());
		if (confidenceMatch) {
			current.confidence = confidenceMatch[1]!.toLowerCase() as StaticCompileCandidate["confidence"];
		}
	}
	if (current?.command) commands.push(current);
	return commands;
}

async function detectStaticCompileCommands(projectRoot: string): Promise<string[]> {
	const commands: string[] = [];

	// ── TypeScript / JavaScript ──────────────────────────────────────────
	try {
		const raw = await fs.readFile(path.join(projectRoot, "package.json"), "utf-8");
		const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
		const scripts = parsed.scripts ?? {};
		const hasPnpm = await fileExists(path.join(projectRoot, "pnpm-lock.yaml"));
		const hasYarn = await fileExists(path.join(projectRoot, "yarn.lock"));
		const hasBun = await fileExists(path.join(projectRoot, "bun.lockb"));
		const runner = hasBun ? "bun" : hasPnpm ? "pnpm" : hasYarn ? "yarn" : "npm";
		for (const key of ["typecheck", "type-check", "tsc", "check", "lint"] as const) {
			if (typeof scripts[key] === "string" && (scripts[key] as string).trim()) {
				commands.push(`${runner} run ${key}`);
				break;
			}
		}
	} catch {
		// not a node project
	}
	if (!commands.some((c) => /typecheck|tsc|lint/.test(c))) {
		if (await fileExists(path.join(projectRoot, "tsconfig.json"))) {
			commands.push("npx tsc --noEmit");
		}
	}

	// ── Python ───────────────────────────────────────────────────────────
	try {
		if (await fileExists(path.join(projectRoot, "pyproject.toml"))) {
			const pyproject = await fs.readFile(path.join(projectRoot, "pyproject.toml"), "utf-8");
			if (/^\[tool\.ruff/m.test(pyproject)) {
				commands.push("ruff check .");
			}
			if (/^\[tool\.mypy/m.test(pyproject)) {
				commands.push("mypy .");
			}
		}
	} catch {
		// ignore
	}
	if (!commands.some((c) => c.includes("ruff"))) {
		if (
			(await fileExists(path.join(projectRoot, ".flake8"))) ||
			(await fileExists(path.join(projectRoot, "setup.cfg")))
		) {
			commands.push("flake8 .");
		}
	}
	if (await fileExists(path.join(projectRoot, "pyrightconfig.json"))) {
		commands.push("pyright");
	}

	// ── Go ───────────────────────────────────────────────────────────────
	if (await fileExists(path.join(projectRoot, "go.mod"))) {
		commands.push("go vet ./...");
	}

	// ── Rust ─────────────────────────────────────────────────────────────
	if (await fileExists(path.join(projectRoot, "Cargo.toml"))) {
		commands.push("cargo check");
	}

	// ── Java / Kotlin (Maven) ────────────────────────────────────────────
	if (await fileExists(path.join(projectRoot, "pom.xml"))) {
		commands.push("mvn compile -q");
	}

	// ── Java / Kotlin (Gradle) ───────────────────────────────────────────
	if (
		(await fileExists(path.join(projectRoot, "build.gradle"))) ||
		(await fileExists(path.join(projectRoot, "build.gradle.kts")))
	) {
		commands.push("gradle compileJava");
	}

	// ── Ruby ─────────────────────────────────────────────────────────────
	if (
		(await fileExists(path.join(projectRoot, "Gemfile"))) &&
		(await fileExists(path.join(projectRoot, ".rubocop.yml")))
	) {
		commands.push("rubocop");
	}

	// ── PHP ──────────────────────────────────────────────────────────────
	if (
		(await fileExists(path.join(projectRoot, "phpstan.neon"))) ||
		(await fileExists(path.join(projectRoot, "phpstan.neon.dist")))
	) {
		commands.push("phpstan analyse");
	}

	// ── C# / .NET ────────────────────────────────────────────────────────
	try {
		const entries = await fs.readdir(projectRoot);
		if (entries.some((e) => e.endsWith(".sln") || e.endsWith(".csproj"))) {
			commands.push("dotnet build --no-restore");
		}
	} catch {
		// ignore
	}

	// ── Dart / Flutter ───────────────────────────────────────────────────
	if (await fileExists(path.join(projectRoot, "pubspec.yaml"))) {
		commands.push("dart analyze");
	}

	return commands;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
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
	const resultsById = new Map(allResults.map((result) => [result.taskId, result]));
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
			const fallbackContext = collectReadonlyFallbackContext(contract, resultsById);
			if (fallbackContext.length > 0) {
				const reason = `${contract.taskId} running with readonly fallback because ${fallbackContext.join("; ")}`;
				knownIssues.push(`W2/3 ${reason}`);
				runnable.push(withReadonlyFallback(contract, fallbackContext));
			} else {
				runnable.push(contract);
			}
			continue;
		}

		const reason = decision.issues.map((issue) => issue.reason).join("; ");
		if (decision.issues.some((issue) => issue.requirement.artifact === "static_compile_commands")) {
			deferred.add(contract.taskId);
			knownIssues.push(`W2/3 ${contract.taskId} deferred: ${reason}`);
			emit({ type: "task_deferred", phase: "W2/3", taskId: contract.taskId, reason, ...(contract.blockedCondition && { blockedCondition: contract.blockedCondition }) });
			continue;
		}
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

/**
 * W2-plan gate. For each write task eligible under planMode, run the worker once
 * in read-only plan mode to obtain an <execution_plan>, have master_planner audit
 * it, and either approve (injecting inputs.approvedPlan) or loop on REVISE up to
 * the revision cap. Tasks that fail planning are dropped (recorded as blocked).
 * Non-eligible tasks pass through unchanged.
 */
async function runPlanGate(args: {
	contracts: TaskContract[];
	allResults: TaskResult[];
	opts: PipelineOptions;
	emit: (e: PipelineEvent) => void;
	knownIssues: string[];
}): Promise<TaskContract[]> {
	const { contracts, allResults, opts, emit, knownIssues } = args;
	const planMode: PlanMode = opts.planMode ?? "off";
	if (planMode === "off") return contracts;

	const auditPlan = opts.planner.auditPlan;
	if (!auditPlan) {
		knownIssues.push("W2/3 planMode enabled but planner has no auditPlan; skipping plan gate");
		return contracts;
	}

	const maxRevisions = opts.maxPlanRevisions ?? 2;
	const artifacts = buildArtifactMap(allResults);
	const upstreamSummary = (contract: TaskContract): string => {
		const parts: string[] = [];
		for (const dep of contract.dependsOn) {
			const m = artifacts.get(dep);
			if (!m) continue;
			const fl = m.get("file_list");
			const rf = m.get("relevant_files");
			if (fl) parts.push(`${dep}.file_list:\n${fl}`);
			if (rf) parts.push(`${dep}.relevant_files:\n${rf}`);
		}
		return parts.join("\n\n");
	};

	const out: TaskContract[] = [];
	for (const contract of contracts) {
		let canWrite = false;
		try {
			canWrite = getPersona(contract.personaId).pathPolicy.canWrite;
		} catch {
			// unknown persona — leave canWrite false so the task passes through.
		}
		const eligible = needsPlanApproval(
			contract.personaId,
			canWrite,
			contract.pathPolicy.allowedGlobs.length,
			contract.requiresPlanApproval,
			planMode,
		);
		if (!eligible) {
			out.push(contract);
			continue;
		}

		const approved = await planOneTask(contract, {
			opts,
			emit,
			knownIssues,
			maxRevisions,
			upstream: upstreamSummary(contract),
			auditPlan,
		});
		if (approved) out.push(approved);
		// Rejected → omitted; planOneTask already emitted/recorded the block.
	}
	return out;
}

/** Run the plan→audit loop for a single eligible task. Returns the approved
 *  contract (with inputs.approvedPlan) or undefined if it could not be approved. */
async function planOneTask(
	contract: TaskContract,
	ctx: {
		opts: PipelineOptions;
		emit: (e: PipelineEvent) => void;
		knownIssues: string[];
		maxRevisions: number;
		upstream: string;
		auditPlan: NonNullable<PlannerBridge["auditPlan"]>;
	},
): Promise<TaskContract | undefined> {
	const { opts, emit, knownIssues, maxRevisions, upstream, auditPlan } = ctx;
	let revisePrior: string[] = [];

	for (let attempt = 0; attempt <= maxRevisions; attempt++) {
		// 1. Worker proposes a plan (read-only).
		let planText: string;
		try {
			const repair = revisePrior.length > 0
				? { feedback: `# Revision required\n${revisePrior.map((c) => `- ${c}`).join("\n")}`, rawOutput: "", attempt: attempt + 1 }
				: undefined;
			const raw = await opts.executor.run(contract, [], repair, { mode: "plan" });
			planText = extractExecutionPlan(typeof raw === "string" ? raw : raw.text);
		} catch (e) {
			const reason = `plan generation failed: ${e instanceof Error ? e.message : String(e)}`;
			knownIssues.push(`W2/3 ${contract.taskId} ${reason}`);
			emit({ type: "plan_audited", phase: "W2/3", taskId: contract.taskId, decision: "blocked", reason });
			return undefined;
		}
		if (!planText) {
			const reason = "worker produced no <execution_plan>";
			knownIssues.push(`W2/3 ${contract.taskId} ${reason}`);
			emit({ type: "plan_audited", phase: "W2/3", taskId: contract.taskId, decision: "blocked", reason });
			return undefined;
		}
		emit({ type: "plan_proposed", phase: "W2/3", taskId: contract.taskId, persona: contract.personaId });

		// 2. Master audits the plan.
		let auditText: string;
		try {
			auditText = await auditPlan({
				taskId: contract.taskId,
				persona: contract.personaId,
				objective: contract.objective,
				allowedGlobs: contract.pathPolicy.allowedGlobs,
				acceptance: contract.acceptance,
				nonGoals: contract.nonGoals ?? [],
				plan: planText,
				upstreamArtifacts: upstream,
			});
		} catch (e) {
			const reason = `plan audit failed: ${e instanceof Error ? e.message : String(e)}`;
			knownIssues.push(`W2/3 ${contract.taskId} ${reason}`);
			emit({ type: "plan_audited", phase: "W2/3", taskId: contract.taskId, decision: "blocked", reason });
			return undefined;
		}
		const audit = compilePlanAudit(auditText);
		if (!audit.ok) {
			const reason = `unparseable plan audit: ${audit.error}`;
			knownIssues.push(`W2/3 ${contract.taskId} ${reason}`);
			emit({ type: "plan_audited", phase: "W2/3", taskId: contract.taskId, decision: "blocked", reason });
			return undefined;
		}

		if (audit.audit.decision === "APPROVED") {
			emit({ type: "plan_audited", phase: "W2/3", taskId: contract.taskId, decision: "APPROVED", reason: audit.audit.reason });
			return {
				...contract,
				inputs: { ...contract.inputs, approvedPlan: planText },
			};
		}

		// REVISE
		emit({ type: "plan_audited", phase: "W2/3", taskId: contract.taskId, decision: "REVISE", reason: audit.audit.reason });
		if (attempt < maxRevisions) {
			emit({ type: "plan_revise", phase: "W2/3", taskId: contract.taskId, attempt: attempt + 1, corrections: audit.audit.corrections });
			revisePrior = audit.audit.corrections;
			continue;
		}
		const reason = `plan still REVISE after ${maxRevisions} revision(s): ${audit.audit.reason || audit.audit.corrections.join("; ")}`;
		knownIssues.push(`W2/3 ${contract.taskId} ${reason}`);
		emit({ type: "plan_audited", phase: "W2/3", taskId: contract.taskId, decision: "blocked", reason });
		return undefined;
	}
	return undefined;
}

function collectReadonlyFallbackContext(
	contract: TaskContract,
	resultsById: Map<string, TaskResult>,
): string[] {
	const out: string[] = [];
	for (const requirement of contract.launchRequirements ?? []) {
		if (!requirement.required) continue;
		const upstream = resultsById.get(requirement.sourceTaskId);
		if (!upstream) continue;
		if (canUseReadonlyFallback(requirement, upstream)) {
			out.push(`${requirement.sourceTaskId}.${requirement.artifact} missing after degraded repo_scout`);
		}
	}
	return out;
}

function withReadonlyFallback(
	contract: TaskContract,
	reasons: string[],
): TaskContract {
	const fallbackConstraints = [
		"Repository scan is in degraded mode. Reconstruct only the minimum required repository perception yourself using bounded readonly workspace access.",
		`Fallback reason(s): ${reasons.join("; ")}`,
		"Allowed fallback operations: read_file, list_directory, grep/glob, shell_fs_read, shell_search, shell_git_read including git ls-files.",
		"Do not modify files, install dependencies, access env/secrets, use network fetch, or run git commit/checkout/reset/push.",
		"Clearly mark your final task_report assumptions/risk_notes if results depend on degraded scan fallback.",
	];
	return {
		...contract,
		inputs: {
			...contract.inputs,
			constraints: [
				...contract.inputs.constraints,
				...fallbackConstraints,
			],
		},
		grantedMcpTools: [
			...new Set([
				...(contract.grantedMcpTools ?? []),
				...READONLY_FALLBACK_GRANTED_TOOLS,
			]),
		],
	};
}

async function retryBlockedContextGaps(args: {
	results: TaskResult[];
	contracts: TaskContract[];
	opts: PipelineOptions;
	emit: (e: PipelineEvent) => void;
	knownIssues: string[];
	gateRetryKeys: Set<string>;
	refreshScheduler: MemoryIndexRefreshScheduler;
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
	const retryResults = await runDag(stripPerceptionDeps(retryContracts), opts, emit, args.refreshScheduler);
	for (const result of retryResults) {
		if (!isContextGapBlocked(result)) continue;
		const contract = byId.get(result.taskId);
		const reason = `${result.taskId} remained blocked after one same-contract context retry`;
		knownIssues.push(`W2/3 ${reason}`);
		emit({ type: "task_deferred", phase: "W2/3", taskId: result.taskId, reason, ...(contract?.blockedCondition && { blockedCondition: contract.blockedCondition }) });
	}
	return retryResults;
}

/**
 * Execute a set of fully-resolved TaskContracts on the dynamic DAG harness
 * (real-time dependency unlocking, write-lock serialisation, launch gate).
 * HarnessEvents are adapted to the legacy "wave" PipelineEvent shape the TUI
 * pipeline panel consumes.
 */
async function runDag(
	contracts: TaskContract[],
	opts: PipelineOptions,
	emit: (e: PipelineEvent) => void,
	refreshScheduler?: MemoryIndexRefreshScheduler,
): Promise<TaskResult[]> {
	const harness = new DynamicHarness();
	return harness.runToCompletion(contracts, {
		projectRoot: opts.projectRoot,
		executor: opts.executor,
		refreshScheduler,
		retryBackoff: opts.retryBackoff,
		...(opts.routePolicy && { routePolicy: opts.routePolicy }),
		onEvent: (event) => {
			switch (event.type) {
				case "task_started":
					emit({ type: "wave", event: { type: "task_start", waveIndex: 0, taskId: event.taskId } });
					break;
				case "task_done":
				case "task_blocked":
				case "task_failed":
					emit({ type: "wave", event: { type: "task_done", waveIndex: 0, result: event.result } });
					break;
				case "task_skipped":
					emit({ type: "wave", event: { type: "task_done", waveIndex: 0, result: { taskId: event.taskId, personaId: "code_executor", status: "blocked", report: "", memoryCandidateBody: undefined, errors: [event.reason], durationMs: 0 } } });
					break;
			}
		},
	});
}

async function writeInlineContextPacks(
	projectRoot: string,
	epicId: string,
	refinement: Map<string, RefinementEntry>,
	refreshScheduler: MemoryIndexRefreshScheduler,
): Promise<void> {
	for (const entry of refinement.values()) {
		const text = entry.contextPack?.trim();
		if (!text) continue;

		const filePath = contextPackPath(projectRoot, epicId, entry.taskId);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, text.endsWith("\n") ? text : `${text}\n`, "utf-8");
		entry.contextPackPath = filePath;
	}
	refreshScheduler.markDirty("W0.5:contextPacks");
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

function normalizeWrittenFilesByTask(
	items: Array<{ taskId: string; files: string[] }> | undefined,
): Array<{ taskId: string; files: string[] }> {
	if (!items?.length) return [];
	return items
		.map(({ taskId, files }) => ({
			taskId,
			files: [...new Set(files.filter((file) => file && !isInternalProcessFile(file)))],
		}))
		.filter((entry) => entry.files.length > 0);
}

function collectChangedFiles(items: Array<{ taskId: string; files: string[] }>): string[] {
	const seen = new Set<string>();
	const changed: string[] = [];
	for (const entry of items) {
		for (const file of entry.files) {
			if (seen.has(file)) continue;
			seen.add(file);
			changed.push(file);
		}
	}
	return changed;
}

function isInternalProcessFile(file: string): boolean {
	const normalized = file.replace(/\\/g, "/");
	return /(^|\/)\.minimum(\/|$)/.test(normalized);
}
