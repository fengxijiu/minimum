import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getPersona } from "../personas/PersonaRegistry.js";
import { loadProjectSkillPrompt } from "../personas/PersonaSkillMap.js";
import type { ChatMessage } from "../types/common.js";
import type { MissionCheckInput } from "./MissionChecker.js";
import type { CoarseDag } from "./TaskContract.js";
import type { TaskContract } from "./TaskContract.js";
import type { PlannerBridge } from "./MiMoPipeline.js";
import type { TaskResult, WorkerExecutor } from "./TaskRunner.js";

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
		refine: async (dag: CoarseDag, perception: TaskResult[], memoryPrefix: string) =>
			collectText(
				client,
				[
					await sys(),
					{
						role: "user",
						content: [
							`# Coarse DAG\n${JSON.stringify(dag)}`,
							`# Perception Reports\n${renderResults(perception)}`,
							`# Canonical Project Memory\n${memoryPrefix || "(none)"}`,
							`# Context Builder Guidance\n${contextBuilder.systemPrompt}`,
							[
								"Refine the needs_refine tasks.",
								"Use the context-builder guidance to synthesize concise per-task ContextPack markdown when it helps downstream workers.",
								"Output a single <refine> block. Each task may include an optional string field named contextPack.",
							].join(" "),
						].join("\n\n"),
					},
				],
				max,
			),
		checkMission: (input: MissionCheckInput) =>
			collectText(
				client,
				[
					missionSys(),
					{
						role: "user",
						content: [
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
						].join("\n\n"),
					},
				],
				max,
			),
		finalize: async (results, candidates, canonicalText) =>
			collectText(
				client,
				[
					await sys(),
					{
						role: "user",
						content: `# Task Reports\n${renderResults(results)}\n\n# Memory Candidates\n${candidates
							.map((c) => `- ${c.sourceTask}.${c.persona} [${c.confidence}] ${c.scope}`)
							.join("\n")}\n\n# Current Canonical Memory\n${canonicalText}\n\nFinalize now. Output a single <finalize> block.`,
					},
				],
				max,
			),
	};
}

export interface WorkerExecutorOptions {
	maxTokens?: number;
	projectRoot?: string;
}

/**
 * Build a WorkerExecutor backed by a completion client. Each task is a single
 * persona turn: the persona system prompt plus the contract's objective,
 * acceptance, and ContextPack path. The persona prompt's _common-footer
 * instructs the model to emit <task_report> and <memory_candidate>.
 */
export function createWorkerExecutor(
	client: CompletionClient,
	opts: WorkerExecutorOptions = {},
): WorkerExecutor {
	return {
		run: async (contract: TaskContract) => {
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
			const systemPrompt = projectSkills ? `${persona.systemPrompt}\n\n${projectSkills}` : persona.systemPrompt;
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
			lines.push(
				"\nComplete the task. End with a <task_report> block and, if you learned something durable, a <memory_candidate> block.",
			);
			return collectText(
				client,
				[
					{ role: "system", content: systemPrompt },
					{ role: "user", content: lines.join("\n") },
				],
				max,
			);
		},
	};
}

function renderResults(results: TaskResult[]): string {
	if (results.length === 0) return "(none)";
	return results
		.map((r) => `## ${r.taskId} (${r.personaId}) — ${r.status}\n${r.report}`)
		.join("\n\n");
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
	for (const p of paths.repairDags) lines.push(`- repairDag: ${p}`);
	for (const p of paths.missionChecks) lines.push(`- missionCheck: ${p}`);
	return lines.length > 0 ? lines.join("\n") : "(none)";
}
