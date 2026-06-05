import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	availableCanonicalMemoryTargets,
	defaultMemorySectionForCandidate,
	defaultMemoryTargetForCandidate,
} from "../memory/governance/index.js";
import type { MemoryCandidate } from "../memory/governance/types.js";
import type {
	IApprovalManager,
	IStreamingClient,
	IToolHost,
} from "../loop/MiMoLoop.js";
import type { BillingMode } from "../clients/MiMoPricing.js";
import type { ICodeValidator } from "../types/validator.js";
import { getPersona } from "../personas/PersonaRegistry.js";
import { loadProjectSkillPrompt, loadGrantedSkillPrompt } from "../personas/PersonaSkillMap.js";
import { renderGrantableCatalog, type GrantableCatalog } from "./CapabilityCatalog.js";
import type { ChatMessage } from "../types/common.js";
import type { MissionCheckInput } from "./MissionChecker.js";
import type { CoarseDag } from "./TaskContract.js";
import type { TaskContract } from "./TaskContract.js";
import type { FinalDeliveryInput, PlannerBridge } from "./MiMoPipeline.js";
import type {
	SchemaRepairRequest,
	TaskResult,
	WorkerExecutionResult,
	WorkerExecutor,
} from "./TaskRunner.js";
import {
	WorkerLoop,
	type WorkerEvent,
	type WorkerUsage,
} from "./WorkerLoop.js";

/**
 * ClientAdapters — turn a streaming chat client into the PlannerBridge and
 * WorkerExecutor that MiMoPipeline depends on.
 *
 * These are the LLM seams of the pipeline. The planner bridge issues the
 * planner/checker calls (compile / refine / mission check / finalize); the worker executor runs
 * a single persona turn. Both are single-shot text completions — tool-using
 * worker loops are a future extension, but the contract/policy/staging
 * machinery is already in place to host them.
 */

const PROMPTS_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"personas",
	"prompts",
);

function loadInlinePrompt(file: string): string {
	return fs.readFileSync(path.join(PROMPTS_DIR, file), "utf-8");
}

/** Minimal structural client — MiMoClient satisfies this. */
export interface CompletionClient {
	streamChat(options: {
		messages: ChatMessage[];
		maxTokens?: number;
	}): AsyncIterable<{ type: string; content?: string }>;
}

/** Stream a single completion and concatenate its content chunks. */
export async function collectText(
	client: CompletionClient,
	messages: ChatMessage[],
	maxTokens?: number,
): Promise<string> {
	let text = "";
	for await (const chunk of client.streamChat({ messages, ...(maxTokens && { maxTokens }) })) {
		if (chunk.type === "content" && chunk.content) text += chunk.content;
		if (chunk.type === "error") throw new Error(chunk.content || "stream error");
	}
	return text;
}

export interface PlannerBridgeOptions {
	maxTokens?: number;
	projectRoot?: string;
}

/** Build a PlannerBridge backed by a completion client + master_planner prompt. */
export function createPlannerBridge(
	client: CompletionClient,
	opts: PlannerBridgeOptions = {},
): PlannerBridge {
	const master = getPersona("master_planner");
	const contextBuilder = getPersona("context_builder");
	const missionCheckerPrompt = loadInlinePrompt("mission_checker.md");
	const sys = async (objective?: string): Promise<ChatMessage> => {
		const projectSkills = opts.projectRoot
			? await loadProjectSkillPrompt({ projectRoot: opts.projectRoot, personaId: "master_planner", stage: "W1", objective })
			: "";
		return { role: "system", content: projectSkills ? `${master.systemPrompt}\n\n${projectSkills}` : master.systemPrompt };
	};
	const missionSys = (): ChatMessage => ({ role: "system", content: missionCheckerPrompt });
	const max = opts.maxTokens ?? master.maxTokens;

	return {
		compile: async (userRequest, memoryPrefix, feedback) => {
			const messages: ChatMessage[] = [
				await sys(userRequest),
				{
					role: "user",
					content: `${memoryPrefix}\n\n# User Request\n${userRequest}\n\nCompile the coarse task DAG now. Output a single <task_dag> block.`,
				},
			];
			if (feedback) {
				messages.push({
					role: "user",
					content: `# Compiler Feedback (previous attempt failed)\n${feedback}\n\nRe-emit the ENTIRE <task_dag> block using only the allowed persona ids.`,
				});
			}
			return collectText(client, messages, max);
		},
		refine: async (dag: CoarseDag, perception: TaskResult[], memoryPrefix: string, catalog?: GrantableCatalog, feedback?: string) => {
			const requiredRefinementTaskIds = dag.phases.flatMap((phase) =>
				phase.tasks.filter((task) => task.needsRefine).map((task) => task.id),
			);
			const userContent = [
				`# Coarse DAG\n${JSON.stringify(dag)}`,
				`# Required Refinement Task IDs\n${JSON.stringify({ requiredRefinementTaskIds })}`,
				`# Perception Reports\n${renderResults(perception)}`,
				`# Canonical Project Memory\n${memoryPrefix || "(none)"}`,
				`# Context Builder Guidance\n${contextBuilder.systemPrompt}`,
				[
					"Refine the needs_refine tasks.",
					"The set of refine.tasks[].taskId values must exactly cover requiredRefinementTaskIds: no missing ids, no renamed ids, no duplicates, and no incremental-only responses.",
					"For write-capable tasks, include allowedGlobs, acceptance, nonGoals, and blockedCondition.",
					"Use the context-builder guidance to synthesize concise per-task ContextPack markdown when it helps downstream workers.",
					"Output a single <refine> block. Each task may include an optional string field named contextPack.",
				].join(" "),
			];
			if (catalog) {
				userContent.push(renderGrantableCatalog(catalog));
			}
			if (feedback) {
				userContent.push(
					`# Refine Feedback\n${feedback}\n\nRe-emit the ENTIRE <refine> block, preserving task ids and correcting launchRequirements / blockedCondition as needed.`,
				);
			}
			return collectText(
				client,
				[
					await sys(),
					{
						role: "user",
						content: userContent.join("\n\n"),
					},
				],
				max,
			);
		},
		checkMission: (input: MissionCheckInput, feedback?: string) => {
			const userContent = [
				"# W3.5 Mission Check Input",
				`## Original User Request\n${input.userRequest}`,
				`## Loop State\nCurrent loop index: ${input.loopIndex}\nMax automatic repair loops: ${input.maxRepairLoops}`,
				`## Coarse DAG\n${JSON.stringify(input.dag)}`,
				`## Persisted Artifacts\n${renderArtifactPaths(input.artifactPaths)}`,
				`## W0.5 Refinement Entries\n${renderRefinements(input.refinements)}`,
				`## Task Results\n${renderResults(input.results)}`,
				`## Known Issues\n${renderKnownIssues(input.knownIssues)}`,
				`## Canonical Project Memory\n${input.canonicalMemory || "(none)"}`,
				[
					"Run the W3.5 acceptance loop now.",
					"Keep the exact Markdown report shape required by your persona prompt.",
					"Use Decision: APPROVED_TO_W4, LOOP_BACK_TO_W1, or NEEDS_HUMAN_CONFIRMATION.",
					"When looping back, include concrete W1 tasks with suggested owner agent names from the existing worker roster.",
				].join(" "),
			];
			if (feedback) {
				userContent.push(
					`## Parser Feedback\n${feedback}\n\nRe-emit the complete W3.5 report and include exactly one valid Decision line.`,
				);
			}
			return collectText(
				client,
				[
					missionSys(),
					{
						role: "user",
						content: userContent.join("\n\n"),
					},
				],
				max,
			);
		},
		finalize: async (results, candidates, canonicalText) =>
			collectText(
				client,
				[
					await sys(),
					{
						role: "user",
						content: [
							`# Task Reports\n${renderResults(results)}`,
							`## Memory Candidates\n${renderFinalizeCandidates(candidates)}`,
							`## Canonical Target Choices\n${availableCanonicalMemoryTargets().map((target) => `- ${target}`).join("\n")}`,
							`## Current Canonical Memory\n${canonicalText}`,
							[
								"Finalize now. Output a single <finalize> block.",
								"Prefer merge or update when the candidate contains durable, evidence-backed project knowledge.",
								"Use archive or reject only when you are intentionally discarding or superseding a candidate.",
								"Every merge or update decision must choose one target from the canonical target choices and should include a section.",
							].join(" "),
						].join("\n\n"),
					},
				],
				max,
			),
		deliver: async (input: FinalDeliveryInput) =>
			collectText(
				client,
				[
					{ role: "system", content: DELIVER_SYS },
					{
						role: "user",
						content: buildStructuredSummary(input),
					},
				],
				max,
			),
		synthesize: async (userRequest, results) =>
			collectText(
				client,
				[
					{ role: "system", content: SYNTHESIS_SYS },
					{
						role: "user",
						content: `# Original Goal\n${userRequest}\n\n# Task Reports\n${renderResults(
							results,
						)}\n\nWrite the conclusion now. Output a single <conclusion> block.`,
					},
				],
				max,
			),
	};
}

function renderFinalizeCandidates(candidates: MemoryCandidate[]): string {
	if (candidates.length === 0) return "(none)";
	return candidates.map((candidate) =>
		JSON.stringify(
			{
				candidateId: `${candidate.sourceTask}.${candidate.persona}`,
				scope: candidate.scope,
				confidence: candidate.confidence,
				relatedFiles: candidate.relatedFiles,
				suggestedTarget: defaultMemoryTargetForCandidate(candidate),
				suggestedSection: defaultMemorySectionForCandidate(candidate),
				body: candidate.body,
			},
			null,
			2,
		),
	).join("\n\n");
}

/**
 * System prompt for the post-W4 synthesis call. Kept separate from the master
 * planner persona so it is free of the planner's strict XML-block constraints —
 * its only job is to read the task reports and tell the user, in plain Markdown,
 * what the run actually produced relative to their goal.
 */
const SYNTHESIS_SYS = [
	"You summarize the outcome of a completed multi-agent run for the user who set the goal.",
	"You are given the original goal and each task's final report.",
	"Write a concise conclusion that answers the goal directly: what was accomplished, the key findings, and the concrete deliverables or recommendations.",
	"Lead with the answer, not a play-by-play of which task did what. Prefer a short paragraph plus a tight bullet list of concrete results.",
	"Ground every claim in the task reports — never invent results that are not present.",
	"Output exactly one <conclusion> block containing Markdown, with no prose before or after it.",
].join(" ");

const DELIVER_SYS = [
	"You compose the user-facing delivery brief for a completed multi-agent pipeline run.",
	"You receive a pre-structured summary containing the original request, task outcomes, written files, and known issues.",
	"Write a clear, concise <final_brief> in Markdown that answers the user's request directly.",
	"Lead with what was accomplished, then list concrete changes made (files written, key findings).",
	"If any tasks were blocked, errored, or produced warnings, surface them under a short warnings section.",
	"Do not expose internal pipeline mechanics, .minimum/** artifacts, or agent-internal details.",
	"Ground every claim in the provided summary — never invent results.",
	"Output exactly one <final_brief> block containing Markdown, with no prose before or after it.",
].join(" ");

function buildStructuredSummary(input: FinalDeliveryInput): string {
	const sections: string[] = ["# W4 Delivery Summary"];

	sections.push(`## Original Request\n${input.userRequest}`);
	sections.push(`## Status\n${input.statusReason}`);

	const taskSummaries = input.results.map((r) => {
		const firstLine = r.report.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
		const summary = firstLine.length > 300 ? firstLine.slice(0, 297) + "..." : firstLine;
		return `- **${r.taskId}** (${r.personaId}): ${r.status}${summary ? ` — ${summary}` : ""}${r.errors.length ? ` [errors: ${r.errors.join("; ")}]` : ""}`;
	}).join("\n");
	sections.push(`## Task Outcomes\n${taskSummaries || "(none)"}`);

	if (input.writtenFilesByTask?.length) {
		const files = input.writtenFilesByTask
			.flatMap((entry) => entry.files)
			.filter((f, i, arr) => arr.indexOf(f) === i);
		sections.push(`## Written Files (${files.length})\n${files.map((f) => `- ${f}`).join("\n")}`);
	}

	if (input.knownIssues.length > 0) {
		const deduped = [...new Set(input.knownIssues)];
		sections.push(`## Known Issues\n${deduped.map((i) => `- ${i}`).join("\n")}`);
	}

	if (input.finalizeReport) {
		const applied = input.finalizeReport.applied.length;
		const errors = input.finalizeReport.errors.length;
		sections.push(`## Memory Governance\n${applied} decisions applied, ${errors} errors`);
	}

	sections.push("Author the user-facing delivery brief now. Output exactly one <final_brief> block.");
	return sections.join("\n\n");
}

export interface WorkerExecutorOptions {
	maxTokens?: number;
	projectRoot?: string;
	/** When set, worker tasks gain real tool execution via WorkerLoop. */
	tools?: IToolHost;
	/** When set, every tool call passes through the approvalMode gate. */
	approvalManager?: IApprovalManager;
	/** When set, post-write validation auto-rolls back via SnapshotManager. */
	validator?: ICodeValidator;
	/** Forwarded to WorkerLoop for cost/currency labelling. */
	model?: string;
	billingMode?: BillingMode;
	/** Optional event sink — fired for each tool call, result, and final usage roll-up. */
	onWorkerEvent?: (
		contract: TaskContract,
		event: WorkerEvent,
	) => void;
	/** Optional usage sink — receives one summary per task. */
	onTaskUsage?: (contract: TaskContract, usage: WorkerUsage) => void;
}

/**
 * Build a WorkerExecutor backed by a completion client. Each task gets a fresh
 * sub-agent session that:
 *   • Loads the persona's prompt + skills,
 *   • Renders objective / acceptance / context-pack into a user message,
 *   • Runs a multi-turn tool-calling loop (WorkerLoop) when `tools` are wired,
 *   • Falls back to a single-shot completion when no tool host is provided
 *     (legacy mode, used by tests with stub clients).
 *
 * The worker's final output is plain text — the calling TaskRunner parses
 * <task_report> and <memory_candidate> blocks out of it.
 */
export function createWorkerExecutor(
	client: CompletionClient,
	opts: WorkerExecutorOptions = {},
): WorkerExecutor {
	const projectRoot = opts.projectRoot ?? process.cwd();
	const workerLoop = opts.tools
		? new WorkerLoop({
			// IStreamingClient is structurally a superset of CompletionClient
			// (it adds `tools` and `signal` on streamChat). MiMoClient satisfies
			// both — the cast is the recognition that callers only wire a real
			// MiMoClient when they also wire a real tool host.
			client: client as unknown as IStreamingClient,
			tools: opts.tools,
			...(opts.approvalManager !== undefined && { approvalManager: opts.approvalManager }),
			...(opts.validator !== undefined && { validator: opts.validator }),
			projectRoot,
			...(opts.model !== undefined && { model: opts.model }),
			...(opts.billingMode !== undefined && { billingMode: opts.billingMode }),
		})
		: undefined;

	return {
		run: async (
			contract: TaskContract,
			_filteredTools: string[],
			repair?: SchemaRepairRequest,
		): Promise<WorkerExecutionResult> => {
			const persona = getPersona(contract.personaId);
			const max = opts.maxTokens ?? persona.maxTokens;
			const projectSkills = opts.projectRoot
				? await loadProjectSkillPrompt({
					projectRoot: opts.projectRoot,
					personaId: contract.personaId,
					stage: contract.phase,
					objective: contract.objective,
				})
				: "";
			const grantedSkills = opts.projectRoot
				? await loadGrantedSkillPrompt(opts.projectRoot, contract.grantedSkills ?? [])
				: "";
			const systemPrompt = [persona.systemPrompt, projectSkills, grantedSkills]
				.filter((s) => s && s.trim())
				.join("\n\n");
			const lines = [
				`# Objective\n${contract.objective}`,
				`\n# Acceptance\n${contract.acceptance.map((a) => `- ${a}`).join("\n")}`,
			];
			if (contract.nonGoals?.length) {
				lines.push(`\n# Non-Goals\n${contract.nonGoals.map((g) => `- ${g}`).join("\n")}`);
			}
			if (contract.blockedCondition) {
				lines.push(`\n# Blocked Condition\n${contract.blockedCondition}`);
			}
			if (contract.inputs.contextPack) {
				lines.push(`\n# Context Pack\nSee ${contract.inputs.contextPack}`);
			}
			if (contract.inputs.constraints.length > 0) {
				lines.push(`\n# Constraints\n${contract.inputs.constraints.map((c) => `- ${c}`).join("\n")}`);
			}
			if (contract.inputs.staticCompileCommands?.length) {
				lines.push(
					`\n# Static Compile Commands\n${contract.inputs.staticCompileCommands.map((command) => `- ${command}`).join("\n")}`,
				);
			}
			if (contract.postStaticCompile?.required) {
				lines.push(
					"\n# Tail Static Compile Requirement\nAfter your main task work, run the static compile command(s) above and do not return a successful final <task_report> until they pass.",
				);
			}
			lines.push(
				"\nComplete the task. Your final response must consist only of the required XML blocks from the system prompt, with no prose before or after them.",
			);
			if (repair) {
				lines.push(`\n# Schema Repair\n${repair.feedback}`);
			}
			const userPrompt = lines.join("\n");

			if (workerLoop) {
				const result = await workerLoop.runTask({
					systemPrompt,
					userPrompt,
					persona,
					contract,
					maxTokens: max,
					onEvent: opts.onWorkerEvent
						? (ev) => opts.onWorkerEvent!(contract, ev)
						: undefined,
				});
				opts.onTaskUsage?.(contract, result.usage);
				return {
					text: result.text,
					hitStepLimit: result.hitStepLimit,
					...(result.emptyFinalTurn !== undefined && { emptyFinalTurn: result.emptyFinalTurn }),
					finishReason: result.finishReason,
					...(repair && { attempt: repair.attempt }),
				};
			}

			// Legacy single-shot path — no tool host wired. Worker still
			// produces a <task_report> string; just no real tool execution.
			const text = await collectText(
				client,
				[
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
				max,
			);
			return {
				text,
				hitStepLimit: false,
				finishReason: text.trim() ? "final" : "empty_stream",
				...(text.trim() ? {} : { emptyFinalTurn: true }),
				...(repair && { attempt: repair.attempt }),
			};
		},
	};
}

function renderResults(results: TaskResult[]): string {
	if (results.length === 0) return "(none)";
	return results
		.map((r) => `## ${r.taskId} (${r.personaId}) — ${r.status}\n${r.report}`)
		.join("\n\n");
}

function renderLeafTaskIds(taskIds: string[]): string {
	if (taskIds.length === 0) return "(none)";
	return taskIds.map((taskId) => `- ${taskId}`).join("\n");
}

function renderWrittenFilesByTask(items: FinalDeliveryInput["writtenFilesByTask"]): string {
	if (!items?.length) return "(none)";
	return items
		.map((entry) => [`### ${entry.taskId}`, ...entry.files.map((file) => `- ${file}`)].join("\n"))
		.join("\n\n");
}

function renderFinalizeReport(report: FinalDeliveryInput["finalizeReport"]): string {
	if (!report) return "(none)";
	return `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``;
}

function renderRefinements(refinements: MissionCheckInput["refinements"]): string {
	if (refinements.length === 0) return "(none)";
	return refinements
		.map((r) => {
			const lines = [
				`## ${r.taskId}`,
				`allowedGlobs: ${r.allowedGlobs.join(", ") || "(none)"}`,
			];
			if (r.acceptance?.length) lines.push(`acceptance: ${r.acceptance.join("; ")}`);
			if (r.nonGoals?.length) lines.push(`nonGoals: ${r.nonGoals.join("; ")}`);
			if (r.blockedCondition) lines.push(`blockedCondition: ${r.blockedCondition}`);
			if (r.constraints?.length) lines.push(`constraints: ${r.constraints.join("; ")}`);
			if (r.contextPackPath) lines.push(`contextPack: ${r.contextPackPath}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

function renderKnownIssues(issues: string[]): string {
	if (issues.length === 0) return "(none)";
	return issues.map((issue) => `- ${issue}`).join("\n");
}

function renderArtifactPaths(paths: MissionCheckInput["artifactPaths"]): string {
	const lines: string[] = [];
	if (paths.dag) lines.push(`- dag: ${paths.dag}`);
	if (paths.memoryIndex) lines.push(`- memoryIndex: ${paths.memoryIndex}`);
	for (const p of paths.refinements) lines.push(`- refinement: ${p}`);
	for (const p of paths.contracts) lines.push(`- contracts: ${p}`);
	for (const p of paths.confirmations) lines.push(`- confirmation: ${p}`);
	for (const p of paths.repairDags) lines.push(`- repairDag: ${p}`);
	for (const p of paths.missionChecks) lines.push(`- missionCheck: ${p}`);
	return lines.length > 0 ? lines.join("\n") : "(none)";
}
