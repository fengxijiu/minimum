import { getPersona } from "../personas/PersonaRegistry.js";
import type { ChatMessage } from "../types/common.js";
import type { CoarseDag } from "./TaskContract.js";
import type { TaskContract } from "./TaskContract.js";
import type { PlannerBridge } from "./MiMoPipeline.js";
import type { TaskResult, WorkerExecutor } from "./TaskRunner.js";

/**
 * ClientAdapters — turn a streaming chat client into the PlannerBridge and
 * WorkerExecutor that MiMoPipeline depends on.
 *
 * These are the LLM seams of the pipeline. The planner bridge issues the three
 * master_planner calls (compile / refine / finalize); the worker executor runs
 * a single persona turn. Both are single-shot text completions — tool-using
 * worker loops are a future extension, but the contract/policy/staging
 * machinery is already in place to host them.
 */

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
}

/** Build a PlannerBridge backed by a completion client + master_planner prompt. */
export function createPlannerBridge(
	client: CompletionClient,
	opts: PlannerBridgeOptions = {},
): PlannerBridge {
	const master = getPersona("master_planner");
	const sys = (): ChatMessage => ({ role: "system", content: master.systemPrompt });
	const max = opts.maxTokens ?? master.maxTokens;

	return {
		compile: (userRequest, memoryPrefix) =>
			collectText(
				client,
				[
					sys(),
					{
						role: "user",
						content: `${memoryPrefix}\n\n# User Request\n${userRequest}\n\nCompile the coarse task DAG now. Output a single <task_dag> block.`,
					},
				],
				max,
			),
		refine: (dag: CoarseDag, perception: TaskResult[]) =>
			collectText(
				client,
				[
					sys(),
					{
						role: "user",
						content: `# Coarse DAG\n${JSON.stringify(dag)}\n\n# Perception Reports\n${renderResults(perception)}\n\nRefine the needs_refine tasks. Output a single <refine> block.`,
					},
				],
				max,
			),
		finalize: (results, candidates, canonicalText) =>
			collectText(
				client,
				[
					sys(),
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
			const lines = [
				`# Objective\n${contract.objective}`,
				`\n# Acceptance\n${contract.acceptance.map((a) => `- ${a}`).join("\n")}`,
			];
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
					{ role: "system", content: persona.systemPrompt },
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
