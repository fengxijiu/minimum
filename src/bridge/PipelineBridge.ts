import {
	createPlannerBridge,
	createWorkerExecutor,
	runPipeline,
	type CompletionClient,
	type PipelineEvent,
	type WaveEvent,
} from "../orchestration/index.js";
import type { UiEvent } from "./EngineBridge.js";

/**
 * PipelineBridge — wrap the W0–W4 orchestrator as a normalized UiEvent stream,
 * mirroring EngineBridge so the TUI can switch between the single-agent loop
 * and the multi-persona pipeline behind the same Runner contract.
 *
 * The bridge owns the planner/worker adapters; callers supply only a streaming
 * client and a project root.
 */
export interface PipelineBridgeOptions {
	projectRoot: string;
	maxTokens?: number;
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
		});
		const executor = createWorkerExecutor(this.client, {
			...(this.opts.maxTokens && { maxTokens: this.opts.maxTokens }),
		});

		let done = false;
		const finished = runPipeline(userInput, {
			projectRoot: this.opts.projectRoot,
			planner,
			executor,
			onEvent: push,
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
			return [
				{
					kind: "tool_result",
					name: `${w.result.taskId} (${w.result.personaId})`,
					ok: w.result.status === "ok",
					content: w.result.status,
				},
			];
		case "stage_pause":
			return [{ kind: "notice", text: `paused: ${w.reason}`, tone: "warn" }];
		default:
			return [];
	}
}
