import {
	createPlannerBridge,
	createWorkerExecutor,
	runPipeline,
	type CompletionClient,
	type PipelineEvent,
	type TaskResult,
	type WaveEvent,
} from "../orchestration/index.js";
import type { UiEvent } from "./EngineBridge.js";
import type { ConfirmationGate } from "../tools/choice/ConfirmationGate.js";

/**
 * PipelineBridge — wrap the W0–W4 orchestrator as a normalized UiEvent stream,
 * including the W3.5 mission-check loop,
 * mirroring EngineBridge so the TUI can switch between the single-agent loop
 * and the multi-persona pipeline behind the same Runner contract.
 *
 * The bridge owns the planner/worker adapters; callers supply only a streaming
 * client and a project root.
 */
export interface PipelineBridgeOptions {
	projectRoot: string;
	maxTokens?: number;
	choiceGate?: ConfirmationGate;
}

export class PipelineBridge {
	constructor(
		private client: CompletionClient,
		private opts: PipelineBridgeOptions,
	) {}

	async *send(userInput: string): AsyncGenerator<UiEvent> {
		const queue: UiEvent[] = [];
		let notify: (() => void) | undefined;
		const wake = () => {
			notify?.();
			notify = undefined;
		};
		const push = (e: PipelineEvent) => {
			for (const ui of translatePipelineEvent(e)) queue.push(ui);
			wake();
		};

		const planner = createPlannerBridge(this.client, {
			...(this.opts.maxTokens && { maxTokens: this.opts.maxTokens }),
			projectRoot: this.opts.projectRoot,
		});
		const executor = createWorkerExecutor(this.client, {
			...(this.opts.maxTokens && { maxTokens: this.opts.maxTokens }),
			projectRoot: this.opts.projectRoot,
		});

		let done = false;
		const finished = runPipeline(userInput, {
			projectRoot: this.opts.projectRoot,
			planner,
			executor,
			onEvent: push,
			choiceGate: this.opts.choiceGate,
		})
			.then((r) => {
				queue.push({ kind: "done", success: r.ok });
			})
			.catch((err: unknown) => {
				queue.push({ kind: "error", text: err instanceof Error ? err.message : String(err) });
				queue.push({ kind: "done", success: false });
			})
			.finally(() => {
				done = true;
				wake();
			});

		while (true) {
			while (queue.length) yield queue.shift()!;
			if (done) break;
			await new Promise<void>((resolve) => {
				notify = resolve;
			});
		}
		await finished;
		while (queue.length) yield queue.shift()!;
	}
}

/** Translate one PipelineEvent into zero or more UiEvents. */
export function translatePipelineEvent(e: PipelineEvent): UiEvent[] {
	switch (e.type) {
		case "phase_start":
			return [{ kind: "pipeline", phase: e.phase, label: e.label }];
		case "memory_loaded":
			return [
				{
					kind: "notice",
					text: `memory: ${e.includedKeys.length} section(s), ~${e.approxTokens} tok${e.truncated ? " (truncated)" : ""}`,
					tone: "info",
				},
			];
		case "dag_compiled":
			return [
				{ kind: "notice", text: `DAG: ${e.epicId} (${e.taskCount} tasks)`, tone: "ok" },
			];
		case "wave":
			return translateWaveEvent(e.event);
		case "refine_done":
			return [
				{
					kind: "notice",
					text: `refine: ${e.contractCount} contracts${e.errorCount ? `, ${e.errorCount} error(s)` : ""}`,
					tone: e.errorCount ? "warn" : "ok",
				},
			];
		case "dag_confirmation_requested":
			return [
				{
					kind: "notice",
					text: `W0.5 DAG confirmation requested\n${e.brief}\n\n${e.flow}${e.artifactPath ? `\nartifact: ${e.artifactPath}` : ""}`,
					tone: "warn",
				},
			];
		case "mission_parse_failed":
			return [
				{
					kind: "notice",
					text: `W3.5 mission parse failed (attempt ${e.attempt}, loop ${e.loopIndex})\nerror: ${e.error}\nraw: ${e.rawExcerpt || "no detailed output returned"}`,
					tone: "warn",
				},
			];
		case "pipeline_choice":
			return [
				{
					kind: "notice",
					text: `choice: ${e.phase} ${e.choiceId} - ${e.reason}`,
					tone: e.choiceId === "approve_to_w4" ? "warn" : "info",
				},
			];
		case "human_confirmation_required":
			return [
				{
					kind: "notice",
					text: `human confirmation required: [${e.phase}] ${e.reason}`,
					tone: "warn",
				},
			];
		case "gate_retry":
			return [
				{
					kind: "notice",
					text: `gate retry: ${e.taskId} attempt ${e.attempt} - ${e.reason}`,
					tone: "warn",
				},
			];
		case "task_deferred":
			return [
				{
					kind: "notice",
					text: `deferred: ${e.taskId} - ${e.reason}${e.blockedCondition ? ` (${e.blockedCondition})` : ""}`,
					tone: "warn",
				},
			];
		case "finalize_done": {
			const r = e.report;
			const merged = r.applied.filter((a) => a.action === "merge" || a.action === "update").length;
			const archived = r.applied.filter((a) => a.action === "archive").length;
			return [
				{
					kind: "notice",
					text: `finalize: ${merged} merged, ${archived} archived${r.errors.length ? `, ${r.errors.length} error(s)` : ""}`,
					tone: r.errors.length ? "warn" : "ok",
				},
			];
		}
		case "pipeline_complete":
			return [
				{ kind: "notice", text: `pipeline complete · ${e.results.length} task(s)`, tone: "ok" },
			];
		case "pipeline_error":
			return [{ kind: "error", text: `[${e.phase}] ${e.error}` }];
		default:
			return [];
	}
}

function translateWaveEvent(w: WaveEvent): UiEvent[] {
	switch (w.type) {
		case "wave_start":
			return [{ kind: "pipeline", phase: "wave", label: `wave ${w.waveIndex}`, detail: `${w.taskCount} task(s)` }];
		case "task_done":
			if (w.result.status === "ok") {
				return [
					{
						kind: "tool_result",
						name: `${w.result.taskId} (${w.result.personaId})`,
						ok: true,
						content: "ok",
					},
				];
			}
			if (w.result.status === "blocked") {
				return [
					{
						kind: "notice",
						text: `blocked: ${w.result.taskId} (${w.result.personaId}) - ${summarizeTaskResult(w.result)}`,
						tone: "warn",
					},
				];
			}
			return [
				{
					kind: "error",
					text: formatTaskError(w.result),
				},
			];
		case "stage_pause":
			return [{ kind: "notice", text: `paused: ${w.reason}`, tone: "warn" }];
		default:
			return [];
	}
}

function formatTaskError(result: TaskResult): string {
	return [
		`task: ${result.taskId}`,
		`persona: ${result.personaId}`,
		`status: ${result.status}`,
		...result.errors.map((e) => `error: ${e}`),
		result.report ? `report: ${summarizeTaskResult(result)}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function summarizeTaskResult(result: TaskResult): string {
	const report = result.report.replace(/\s+/g, " ").trim();
	if (result.errors.length > 0) return result.errors.join("; ");
	if (report) return report.slice(0, 240);
	return "no detailed task report returned";
}
