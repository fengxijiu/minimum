import type { ApprovalManager } from "../approval/ApprovalManager.js";
import type { ApprovalResponse } from "../approval/types.js";
import type { BillingMode } from "../clients/MiMoPricing.js";
import type { IToolHost } from "../loop/MiMoLoop.js";
import type { ICodeValidator } from "../types/validator.js";
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
	/** When supplied (with `approvalManager`), workers gain real tool execution
	 *  via WorkerLoop. Without it the workers fall back to single-shot text
	 *  completions (legacy behaviour kept for tests). */
	tools?: IToolHost;
	/** Shared with the single-agent loop so the same approvalMode (read-only /
	 *  auto-edit / full-auto) governs both surfaces. */
	approvalManager?: ApprovalManager;
	/** Same CodeValidator used by the single-agent loop. When wired, worker
	 *  writes that fail tsc/syntax/pattern checks roll back automatically and
	 *  the worker hears the diagnostic on the next turn. */
	validator?: ICodeValidator;
	/** Pricing-table inputs — without these, cost would be calculated against the
	 *  default pro/CNY combo. */
	model?: string;
	billingMode?: BillingMode;
}

export class PipelineBridge {
	private pendingApprovals = new Map<string, (response: ApprovalResponse) => void>();

	constructor(
		private client: CompletionClient,
		private opts: PipelineBridgeOptions,
	) {}

	/**
	 * Build the prompter callback we register on ApprovalManager only while a
	 * send() is in flight. Outside of orchestrate mode the prompter stays bound
	 * to EngineBridge, so single-agent prompts keep working unchanged.
	 */
	private buildPrompter(pushUi: (e: UiEvent) => void) {
		return async (req: { id: string; tool: string; args: Record<string, unknown>; risk: "low" | "medium" | "high"; description: string }): Promise<ApprovalResponse> => {
			return new Promise<ApprovalResponse>((resolve) => {
				this.pendingApprovals.set(req.id, resolve);
				pushUi({
					kind: "permission_request",
					id: req.id,
					tool: req.tool,
					args: req.args,
					risk: req.risk,
					description: req.description,
				});
			});
		};
	}

	/** Forward an approval verdict from the TUI back into the worker loop. */
	resolvePermission(id: string, response: ApprovalResponse): void {
		const resolver = this.pendingApprovals.get(id);
		if (resolver) {
			this.pendingApprovals.delete(id);
			resolver(response);
		}
	}

	async *send(userInput: string): AsyncGenerator<UiEvent> {
		const queue: UiEvent[] = [];
		let notify: (() => void) | undefined;
		const wake = () => {
			notify?.();
			notify = undefined;
		};
		// Per-task accumulator — every worker event updates and re-emits the
		// snapshot so the TUI can render a live brief without having to
		// re-derive state from a stream of partial updates.
		const progress = new Map<string, SubagentProgress>();
		const emitProgress = (
			contract: import("../orchestration/TaskContract.js").TaskContract,
			snapshot: SubagentProgress,
		) => {
			pushUi({
				kind: "subagent_progress",
				taskId: contract.taskId,
				personaId: contract.personaId,
				objective: clip(contract.objective, 80),
				step: snapshot.step,
				maxSteps: snapshot.maxSteps,
				toolCalls: snapshot.toolCalls,
				...(snapshot.lastTool !== undefined && { lastTool: snapshot.lastTool }),
				...(snapshot.lastToolArgs !== undefined && { lastToolArgs: snapshot.lastToolArgs }),
				tokens: snapshot.tokens,
				cost: snapshot.cost,
				currency: snapshot.currency,
				status: snapshot.status,
			});
		};
		const push = (e: PipelineEvent) => {
			for (const ui of translatePipelineEvent(e)) queue.push(ui);
			// Wave task_done is the authoritative terminal signal — flip the
			// per-task status so the TUI can stop drawing it as "running".
			if (e.type === "wave") {
				const w = e.event;
				if (w.type === "task_done") {
					const snap = progress.get(w.result.taskId);
					if (snap) {
						snap.status =
							w.result.status === "ok"
								? "done"
								: w.result.status === "blocked"
									? "blocked"
									: "error";
						snap.updatedAt = Date.now();
						pushUi({
							kind: "subagent_progress",
							taskId: w.result.taskId,
							personaId: w.result.personaId,
							objective: snap.objective,
							step: snap.step,
							maxSteps: snap.maxSteps,
							toolCalls: snap.toolCalls,
							...(snap.lastTool !== undefined && { lastTool: snap.lastTool }),
							...(snap.lastToolArgs !== undefined && { lastToolArgs: snap.lastToolArgs }),
							tokens: snap.tokens,
							cost: snap.cost,
							currency: snap.currency,
							status: snap.status,
						});
					}
				}
			}
			wake();
		};
		const pushUi = (e: UiEvent) => {
			queue.push(e);
			wake();
		};

		// Take over the ApprovalManager's prompter for the duration of this
		// pipeline run; pushPrompter returns a restore callback we invoke in
		// the finally block so EngineBridge's single-agent prompter is rebound
		// once we're done.
		const restorePrompter = this.opts.approvalManager?.pushPrompter(
			this.buildPrompter(pushUi),
		);

		const planner = createPlannerBridge(this.client, {
			...(this.opts.maxTokens && { maxTokens: this.opts.maxTokens }),
			projectRoot: this.opts.projectRoot,
		});
		const executor = createWorkerExecutor(this.client, {
			...(this.opts.maxTokens && { maxTokens: this.opts.maxTokens }),
			projectRoot: this.opts.projectRoot,
			...(this.opts.tools && { tools: this.opts.tools }),
			...(this.opts.approvalManager && { approvalManager: this.opts.approvalManager }),
			...(this.opts.validator && { validator: this.opts.validator }),
			...(this.opts.model && { model: this.opts.model }),
			...(this.opts.billingMode && { billingMode: this.opts.billingMode }),
			onWorkerEvent: (contract, ev) => {
				let snap = progress.get(contract.taskId);
				if (!snap) {
					snap = {
						objective: clip(contract.objective, 80),
						step: 0,
						maxSteps: 0,
						toolCalls: 0,
						tokens: 0,
						cost: 0,
						currency: this.opts.billingMode === "tokenPlan" ? "Credits" : "CNY",
						status: "running",
						startedAt: Date.now(),
						updatedAt: Date.now(),
					};
					progress.set(contract.taskId, snap);
				}
				switch (ev.type) {
					case "tool_call":
						snap.toolCalls += 1;
						snap.lastTool = ev.toolName;
						snap.lastToolArgs = clip(summariseArgs(ev.args), 60);
						break;
					case "tool_result":
						// Tool result keeps lastTool but updates timestamp; status hint
						// from a non-ok result is left to the wave task_done signal.
						break;
					case "tool_denied":
						snap.lastTool = `${ev.toolName} (denied)`;
						snap.lastToolArgs = clip(ev.reason, 60);
						break;
					case "tool_rolled_back":
						// Validation failed -> file was restored. Surface as the
						// current action so the user understands why the brief
						// keeps showing the same step.
						snap.lastTool = `${ev.toolName} (${ev.restored ? "rolled back" : "rollback failed"})`;
						snap.lastToolArgs = clip(
							`${ev.path} · ${ev.issues} issue${ev.issues === 1 ? "" : "s"}`,
							60,
						);
						break;
					case "usage":
						snap.tokens = ev.usage.totalTokens;
						snap.cost = ev.usage.totalCost;
						snap.currency = ev.usage.currency;
						snap.toolCalls = ev.usage.toolCalls;
						snap.step = ev.usage.steps;
						break;
					case "content":
					case "reasoning":
						break;
				}
				snap.updatedAt = Date.now();
				emitProgress(contract, snap);
			},
			onTaskUsage: (contract, usage) => {
				const snap = progress.get(contract.taskId);
				if (snap) {
					snap.tokens = usage.totalTokens;
					snap.cost = usage.totalCost;
					snap.currency = usage.currency;
					snap.toolCalls = usage.toolCalls;
					snap.step = usage.steps;
					snap.updatedAt = Date.now();
					emitProgress(contract, snap);
				}
			},
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

		try {
			while (true) {
				while (queue.length) yield queue.shift()!;
				if (done) break;
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
			}
			await finished;
			while (queue.length) yield queue.shift()!;
		} finally {
			restorePrompter?.();
			// Drop any approvals that were still pending — the user already
			// moved on; better to break the dangling promise than to leave it
			// hanging and resolve it against the next run.
			this.pendingApprovals.clear();
		}
	}
}

/**
 * Per-task progress snapshot maintained inside one send() call. Mutated in
 * place as worker events come in; emitted as a `subagent_progress` UiEvent on
 * every change so the TUI brief stays in sync.
 */
interface SubagentProgress {
	objective: string;
	step: number;
	maxSteps: number;
	toolCalls: number;
	lastTool?: string;
	lastToolArgs?: string;
	tokens: number;
	cost: number;
	currency: "CNY" | "Credits";
	status: "running" | "done" | "error" | "blocked";
	startedAt: number;
	updatedAt: number;
}

function clip(s: string, n: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

/** Reduce a raw JSON tool-args blob to a one-line glance string. */
function summariseArgs(raw: string): string {
	try {
		const obj = JSON.parse(raw);
		const path = obj?.path ?? obj?.file_path ?? obj?.filepath ?? obj?.url;
		if (typeof path === "string") return path;
		const command = obj?.command;
		if (typeof command === "string") return command;
		const pattern = obj?.pattern;
		if (typeof pattern === "string") return `"${pattern}"`;
		return raw;
	} catch {
		return raw;
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
	const lines: string[] = [
		`status: ${result.status}`,
		`task: ${result.taskId}`,
		`persona: ${result.personaId}`,
	];
	for (const e of result.errors) lines.push(`error: ${e}`);
	if (result.report) {
		lines.push(`report: ${summarizeTaskResult(result)}`);
	} else if (result.errors.length === 0) {
		lines.push("error: no detailed output captured — check the worker log or task_report artifact");
	}
	if (result.stagingError) lines.push(`staging_error: ${result.stagingError}`);
	if (Number.isFinite(result.durationMs)) lines.push(`duration_ms: ${result.durationMs}`);
	return lines.join("\n");
}

function summarizeTaskResult(result: TaskResult): string {
	const report = result.report.replace(/\s+/g, " ").trim();
	if (result.errors.length > 0) return result.errors.join("; ");
	if (report) return report.slice(0, 240);
	return "no detailed task report returned";
}
