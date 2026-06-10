import type { ApprovalManager } from "../approval/ApprovalManager.js";
import type { ApprovalResponse } from "../approval/types.js";
import type { BillingMode } from "../clients/MiMoPricing.js";
import type { IToolHost } from "../loop/MiMoLoop.js";
import { buildGrantableCatalog, type GrantableCatalog } from "../orchestration/CapabilityCatalog.js";
import type { ICodeValidator } from "../types/validator.js";
import {
	classifyRoutePolicy,
	createPlannerBridge,
	createWorkerExecutor,
	parseRouteHintFromInput,
	runPipeline,
	stageName,
	type CompletionClient,
	type HarnessEvent,
	type PipelineEvent,
	type PipelineResult,
	type PlanMode,
	type RouteHint,
	type RoutePolicy,
	type TaskResult,
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
	/** Master-granted capability policy (denylist + kill switch); from MiMoConfig. */
	capabilityGrants?: { enabled?: boolean; denylistSkills?: string[]; denylistMcpTools?: string[] };
	/** W2-plan audit gate: which write tasks must propose+get a plan approved before executing. */
	planMode?: PlanMode;
	/** Cap on REVISE round-trips for the W2-plan gate (default 2). */
	maxPlanRevisions?: number;
	/** Static route hint used when the caller wants to force a path for every send. */
	routeHint?: RouteHint;
	/** Pre-resolved route policy; usually omitted so send() can classify per request. */
	routePolicy?: RoutePolicy;
}

/**
 * Build the grantable-capability catalog for a run: learned skills + the MCP
 * tools advertised by the shared tool host (names start with `mcp__`), minus the
 * configured denylists. Returns undefined when grants are disabled so the
 * pipeline offers/validates nothing.
 */
export async function buildCatalogForBridge(opts: {
	projectRoot: string;
	tools?: IToolHost;
	capabilityGrants?: { enabled?: boolean; denylistSkills?: string[]; denylistMcpTools?: string[] };
}): Promise<GrantableCatalog | undefined> {
	if (opts.capabilityGrants?.enabled === false) return undefined;
	const mcpTools = (opts.tools?.getDefinitions() ?? [])
		.filter((t) => t.name.startsWith("mcp__"))
		.map((t) => ({ name: t.name, description: t.description ?? "" }));
	return buildGrantableCatalog({
		projectRoot: opts.projectRoot,
		mcpTools,
		denylistSkills: opts.capabilityGrants?.denylistSkills ?? [],
		denylistMcpTools: opts.capabilityGrants?.denylistMcpTools ?? [],
	});
}

export class PipelineBridge {
	private pendingApprovals = new Map<string, (response: ApprovalResponse) => void>();
	private history: import("../types/common.js").ChatMessage[] = [];
	private planGateMode: PlanMode;

	constructor(
		private client: CompletionClient,
		private opts: PipelineBridgeOptions,
	) {
		this.planGateMode = opts.planMode ?? "off";
	}

	/** Switch the W2-plan audit gate at runtime (off / code_personas / all_writes). */
	setPlanGateMode(mode: PlanMode): void {
		this.planGateMode = mode;
	}

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

	getHistory(): import("../types/common.js").ChatMessage[] {
		return this.history.map((message) => ({ ...message }));
	}

	loadHistory(messages: import("../types/common.js").ChatMessage[]): void {
		// NEW: restore only the top-level orchestrate conversation we emit back to the TUI.
		this.history = messages.map((message) => ({ ...message }));
	}

	async *send(userInput: string): AsyncGenerator<UiEvent> {
		const ac = new AbortController();
		const parsed = parseRouteHintFromInput(userInput);
		const cleanUserInput = parsed.cleanInput || userInput;
		const routeHint = parsed.routeHint ?? this.opts.routeHint;
		const routePolicy = this.opts.routePolicy ?? classifyRoutePolicy(cleanUserInput, routeHint);
		const effectiveInput = this.buildUserRequest(cleanUserInput);
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
		// Per-task usage snapshots — each worker's latest cumulative usage.
		// Re-summed on every update to drive the top-level ctx/cost meter.
		const taskUsageSnapshots = new Map<string, {
			totalTokens: number; promptTokens: number; completionTokens: number;
			cachedTokens: number; toolCalls: number; steps: number;
			totalCost: number; currency: "CNY" | "Credits";
		}>();
		const usageAccum = {
			totalTokens: 0, promptTokens: 0, completionTokens: 0,
			cachedTokens: 0, toolCalls: 0, steps: 0,
			totalCost: 0, currency: "CNY" as "CNY" | "Credits",
		};
		// Files each task actually wrote, accumulated from worker tool calls.
		// pendingWriteByTask remembers the path of the most recent write call so a
		// later denial/rollback can retract it (the deny/rollback signals don't
		// always carry the path themselves).
		const writtenByTask = new Map<string, Set<string>>();
		const pendingWriteByTask = new Map<string, string>();
		const recordWrite = (taskId: string, p: string) => {
			let set = writtenByTask.get(taskId);
			if (!set) {
				set = new Set<string>();
				writtenByTask.set(taskId, set);
			}
			set.add(p);
			pendingWriteByTask.set(taskId, p);
		};
		const retractPendingWrite = (taskId: string, p?: string) => {
			const target = p ?? pendingWriteByTask.get(taskId);
			if (target) writtenByTask.get(taskId)?.delete(target);
			pendingWriteByTask.delete(taskId);
		};
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
			if (e.type === "pipeline_complete") {
				const { text, tone } = summarizePipelineBrief(e.results, metaOf(e));
				queue.push({ kind: "assistant", text });
			} else {
				for (const ui of translatePipelineEvent(e)) queue.push(ui);
			}
			// NEW: Harness task terminal events are authoritative for final status.
			const terminal = getTerminalTaskUpdate(e);
			if (terminal) {
				const snap = progress.get(terminal.taskId);
				if (snap) {
					snap.status = terminal.status;
					snap.updatedAt = Date.now();
					pushUi({
						kind: "subagent_progress",
						taskId: terminal.taskId,
						personaId: terminal.personaId ?? "code_executor",
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
			wake();
		};
		const pushUi = (e: UiEvent) => {
			queue.push(e);
			wake();
		};
		const recalcUsage = () => {
			usageAccum.totalTokens = 0;
			usageAccum.promptTokens = 0;
			usageAccum.completionTokens = 0;
			usageAccum.cachedTokens = 0;
			usageAccum.toolCalls = 0;
			usageAccum.steps = 0;
			usageAccum.totalCost = 0;
			for (const snap of taskUsageSnapshots.values()) {
				usageAccum.totalTokens += snap.totalTokens;
				usageAccum.promptTokens += snap.promptTokens;
				usageAccum.completionTokens += snap.completionTokens;
				usageAccum.cachedTokens += snap.cachedTokens;
				usageAccum.toolCalls += snap.toolCalls;
				usageAccum.steps += snap.steps;
				usageAccum.totalCost += snap.totalCost;
				usageAccum.currency = snap.currency;
			}
		};
		const emitAggregatedUsage = () => {
			pushUi({
				kind: "usage",
				contextTokens: usageAccum.totalTokens,
				totalTokens: usageAccum.totalTokens,
				promptTokens: usageAccum.promptTokens,
				completionTokens: usageAccum.completionTokens,
				cachedTokens: usageAccum.cachedTokens,
				toolCalls: usageAccum.toolCalls,
				steps: usageAccum.steps,
				totalCost: usageAccum.totalCost,
				currency: usageAccum.currency,
			});
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
			routePolicy,
		});
		const executor = createWorkerExecutor(this.client, {
			...(this.opts.maxTokens && { maxTokens: this.opts.maxTokens }),
			projectRoot: this.opts.projectRoot,
			routePolicy,
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
					case "tool_call": {
						snap.toolCalls += 1;
						snap.lastTool = ev.toolName;
						snap.lastToolArgs = clip(summariseArgs(ev.args), 60);
						const writePath = extractWritePath(ev.toolName, ev.args);
						if (writePath) recordWrite(contract.taskId, writePath);
						else pendingWriteByTask.delete(contract.taskId);
						break;
					}
					case "tool_result":
						// Tool result keeps lastTool but updates timestamp; terminal
						// status still comes from the harness task completion events.
						// A clean result commits the pending write.
						pendingWriteByTask.delete(contract.taskId);
						break;
					case "tool_denied":
						snap.lastTool = `${ev.toolName} (denied)`;
						snap.lastToolArgs = clip(ev.reason, 60);
						// The write never landed - drop it from the task's file list.
						retractPendingWrite(contract.taskId);
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
						// A restored file is not a real write; retract it by path.
						if (ev.restored) retractPendingWrite(contract.taskId, ev.path);
						break;
					case "usage":
						snap.tokens = ev.usage.totalTokens;
						snap.cost = ev.usage.totalCost;
						snap.currency = ev.usage.currency;
						snap.toolCalls = ev.usage.toolCalls;
						snap.step = ev.usage.steps;
						taskUsageSnapshots.set(contract.taskId, {
							totalTokens: ev.usage.totalTokens,
							promptTokens: ev.usage.promptTokens,
							completionTokens: ev.usage.completionTokens,
							cachedTokens: ev.usage.cachedTokens,
							toolCalls: ev.usage.toolCalls,
							steps: ev.usage.steps,
							totalCost: ev.usage.totalCost,
							currency: ev.usage.currency,
						});
						recalcUsage();
						emitAggregatedUsage();
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
				taskUsageSnapshots.set(contract.taskId, {
					totalTokens: usage.totalTokens,
					promptTokens: usage.promptTokens,
					completionTokens: usage.completionTokens,
					cachedTokens: usage.cachedTokens,
					toolCalls: usage.toolCalls,
					steps: usage.steps,
					totalCost: usage.totalCost,
					currency: usage.currency,
				});
				recalcUsage();
				emitAggregatedUsage();
			},
		});

		let done = false;
		const grantableCatalog = await buildCatalogForBridge({
			projectRoot: this.opts.projectRoot,
			tools: this.opts.tools,
			capabilityGrants: this.opts.capabilityGrants,
		});
		const finished = runPipeline(effectiveInput, {
			projectRoot: this.opts.projectRoot,
			planner,
			executor,
			routePolicy,
			...(routeHint && { routeHint }),
			onEvent: push,
			choiceGate: this.opts.choiceGate,
			planMode: this.planGateMode,
			signal: ac.signal,
			...(this.opts.maxPlanRevisions !== undefined && { maxPlanRevisions: this.opts.maxPlanRevisions }),
			getDeliveryWrites: () =>
				[...writtenByTask.entries()]
					.map(([taskId, files]) => ({
						taskId,
						files: [...files].filter((file) => !isInternalProcessFile(file)),
					}))
					.filter((entry) => entry.files.length > 0),
			...(grantableCatalog && { grantableCatalog }),
		})
			.then((r) => {
				this.recordTurn(cleanUserInput, summarizePipelineResult(r));
				queue.push({ kind: "done", success: r.ok });
			})
			.catch((err: unknown) => {
				this.recordTurn(
					cleanUserInput,
					`Pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
				);
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
			ac.abort();
			restorePrompter?.();
			// Drop any approvals that were still pending — the user already
			// moved on; better to break the dangling promise than to leave it
			// hanging and resolve it against the next run.
			this.pendingApprovals.clear();
		}
	}

	private buildUserRequest(userInput: string): string {
		if (this.history.length === 0) return userInput;
		const recent = this.history.slice(-8);
		return [
			"Previous orchestrate conversation context:",
			renderPipelineHistory(recent),
			"",
			"Current user request:",
			userInput,
			"",
			"Preserve relevant context from the prior conversation only when it helps with the current request.",
		].join("\n");
	}

	private recordTurn(userInput: string, assistantSummary: string): void {
		const next: import("../types/common.js").ChatMessage[] = [
			...this.history,
			{ role: "user", content: userInput },
			{ role: "assistant", content: assistantSummary },
		];
		// NEW: cap stored orchestrate history so resumed prompts stay bounded.
		this.history = next.slice(-12).map((message) => ({ ...message }));
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

/** Tools whose successful call means a file was written under the task scope. */
const WRITE_TOOLS = new Set(["write_file", "edit_file", "apply_patch"]);

/**
 * Pull the target path out of a write tool's JSON args, or undefined for
 * non-write tools / unparseable args. apply_patch may not carry a single path
 * (it embeds a patch blob); we only surface the obvious single-file cases.
 */
function extractWritePath(toolName: string, rawArgs: string): string | undefined {
	if (!WRITE_TOOLS.has(toolName)) return undefined;
	try {
		const obj = JSON.parse(rawArgs);
		const p = obj?.path ?? obj?.file_path ?? obj?.filepath;
		if (typeof p === "string" && p.trim()) return p.trim();
	} catch {
		// ignore malformed args
	}
	return undefined;
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
		case "harness":
			return translateHarnessEvent(e.event);
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
					text: `Refine DAG confirmation ready${e.artifactPath ? ` · ${e.artifactPath}` : ""}`,
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
					text: `choice: ${stageName(e.phase)} ${e.choiceId} - ${e.reason}`,
					tone: e.choiceId === "approve_to_w4" ? "warn" : "info",
				},
			];
		case "human_confirmation_required":
			return [
				{
					kind: "notice",
					text: `human confirmation required: [${stageName(e.phase)}] ${e.reason}`,
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
		case "pipeline_complete": {
			const { text, tone } = summarizePipelineBrief(e.results, metaOf(e));
			return [{ kind: "notice", text, tone }];
		}
		case "pipeline_error":
			return [{ kind: "error", text: `[${e.phase}] ${e.error}` }];
		default:
			return [];
	}
}

function translateHarnessEvent(event: HarnessEvent): UiEvent[] {
	switch (event.type) {
		case "harness_start":
			return [{ kind: "pipeline", phase: "scheduler", label: "dynamic queue", detail: `${event.taskCount} task(s)` }];
		case "task_done":
			if (event.result.status === "ok") {
				return [
					{
						kind: "tool_result",
						name: `${event.result.taskId} (${event.result.personaId})`,
						ok: true,
						content: "ok",
					},
				];
			}
			if (event.result.status === "blocked") {
				return [
					{
						kind: "notice",
						text: `blocked: ${event.result.taskId} (${event.result.personaId}) - ${summarizeTaskResult(event.result)}`,
						tone: "warn",
					},
				];
			}
			return [
				{
					kind: "error",
					text: formatTaskError(event.result),
				},
			];
		case "task_blocked":
			return [
				{
					kind: "notice",
					text: `blocked: ${event.result.taskId} (${event.result.personaId}) - ${summarizeTaskResult(event.result)}`,
					tone: "warn",
				},
			];
		case "task_failed":
			return [
				{
					kind: "error",
					text: formatTaskError(event.result),
				},
			];
		case "task_skipped":
			return [{ kind: "notice", text: `skipped: ${event.taskId} - ${event.reason}`, tone: "warn" }];
		case "queue_idle":
			return [
				{
					kind: "notice",
					text: `paused: queue idle (${event.pending} pending, ${event.blocked} blocked, ${event.deferred} deferred)`,
					tone: "warn",
				},
			];
		default:
			return [];
	}
}

function getTerminalTaskUpdate(
	event: PipelineEvent,
): { taskId: string; personaId?: string; status: "done" | "blocked" | "error" } | undefined {
	if (event.type !== "harness") return undefined;
	if (event.event.type === "task_done") {
		return {
			taskId: event.event.result.taskId,
			personaId: event.event.result.personaId,
			status: event.event.result.status === "ok" ? "done" : event.event.result.status === "blocked" ? "blocked" : "error",
		};
	}
	if (event.event.type === "task_blocked") {
		return {
			taskId: event.event.result.taskId,
			personaId: event.event.result.personaId,
			status: "blocked",
		};
	}
	if (event.event.type === "task_failed") {
		return {
			taskId: event.event.result.taskId,
			personaId: event.event.result.personaId,
			status: "error",
		};
	}
	if (event.event.type === "task_skipped") {
		return {
			taskId: event.event.taskId,
			status: "blocked",
		};
	}
	return undefined;
}

/**
 * Build the W4 completion summary shown in the TUI once the pipeline finishes.
 * Pure over the task results so it stays unit-testable: a header with status
 * totals, a per-persona tally of where the work went, and a per-task list of
 * what each task produced (its task_report) plus execution details.
 */
/**
 * Goal-and-deliverable context for the W4 summary. Sourced from the
 * pipeline_complete event: the original goal, a synthesized conclusion, the
 * terminal (leaf) task ids whose reports are the actual deliverables, and the
 * persisted artifact paths.
 */
export interface CompletionMeta {
	goal?: string;
	finalBrief?: string;
	changedFiles?: string[];
	traceArtifacts?: string[];
	conclusion?: string;
	leafTaskIds?: string[];
	artifacts?: string[];
}

/** Project the completion context off a pipeline_complete event into CompletionMeta. */
function metaOf(e: Extract<PipelineEvent, { type: "pipeline_complete" }>): CompletionMeta {
	return {
		...(e.goal !== undefined && { goal: e.goal }),
		...(e.finalBrief !== undefined && { finalBrief: e.finalBrief }),
		...(e.changedFiles !== undefined && { changedFiles: e.changedFiles }),
		...(e.traceArtifacts !== undefined && { traceArtifacts: e.traceArtifacts }),
		...(e.conclusion !== undefined && { conclusion: e.conclusion }),
		...(e.leafTaskIds !== undefined && { leafTaskIds: e.leafTaskIds }),
		...(e.artifacts !== undefined && { artifacts: e.artifacts }),
	};
}

export function summarizePipelineBrief(
	results: TaskResult[],
	meta?: Pick<CompletionMeta, "finalBrief" | "conclusion" | "changedFiles">,
): { text: string; tone: "ok" | "warn" } {
	const blocked = results.filter((r) => r.status === "blocked");
	const degraded = results.filter((r) => r.status === "degraded");
	const skipped = results.filter((r) => r.status === "skipped");
	const errored = results.filter((r) => r.status !== "ok" && r.status !== "blocked" && r.status !== "degraded" && r.status !== "skipped");
	const brief = (meta?.finalBrief ?? meta?.conclusion ?? "").trim();
	return {
		text: brief || "Task completed, but no final brief was produced.",
		tone: blocked.length || degraded.length || skipped.length || errored.length ? "warn" : "ok",
	};
}

export function summarizePipelineComplete(
	results: TaskResult[],
	writtenByTask?: Map<string, Set<string>>,
	meta?: CompletionMeta,
): { text: string; tone: "ok" | "warn" } {
	const ok = results.filter((r) => r.status === "ok");
	const degraded = results.filter((r) => r.status === "degraded");
	const skipped = results.filter((r) => r.status === "skipped");
	const blocked = results.filter((r) => r.status === "blocked");
	const errored = results.filter((r) => r.status !== "ok" && r.status !== "degraded" && r.status !== "skipped" && r.status !== "blocked");

	const lines: string[] = [
		`Pipeline complete (W4) · ${results.length} task(s): ${ok.length} ok, ${degraded.length} degraded, ${skipped.length} skipped, ${blocked.length} blocked, ${errored.length} error`,
	];

	if (meta?.goal) lines.push(`goal: ${clip(meta.goal, 200)}`);

	const byPersona = new Map<string, { ok: number; degraded: number; skipped: number; blocked: number; error: number }>();
	for (const r of results) {
		const tally = byPersona.get(r.personaId) ?? { ok: 0, degraded: 0, skipped: 0, blocked: 0, error: 0 };
		if (r.status === "ok") tally.ok += 1;
		else if (r.status === "degraded") tally.degraded += 1;
		else if (r.status === "skipped") tally.skipped += 1;
		else if (r.status === "blocked") tally.blocked += 1;
		else tally.error += 1;
		byPersona.set(r.personaId, tally);
	}
	const personaLine = [...byPersona.entries()]
		.map(([persona, t]) => {
			const parts = [`${t.ok} ok`];
			if (t.degraded) parts.push(`${t.degraded} degraded`);
			if (t.skipped) parts.push(`${t.skipped} skipped`);
			if (t.blocked) parts.push(`${t.blocked} blocked`);
			if (t.error) parts.push(`${t.error} error`);
			return `${persona}: ${parts.join("/")}`;
		})
		.join(" · ");
	if (personaLine) lines.push(`by persona — ${personaLine}`);

	// Headline: the synthesized conclusion answering the goal.
	if (meta?.conclusion) {
		lines.push("conclusion:");
		lines.push(...indentBlock(meta.conclusion, 800));
	}

	// Deliverables: terminal task reports at higher fidelity than the ledger.
	const leafSet = new Set(meta?.leafTaskIds ?? []);
	const leaves = results.filter((r) => leafSet.has(r.taskId));
	if (leaves.length) {
		lines.push("result:");
		for (const r of leaves) {
			lines.push(`  - ${r.taskId} (${r.personaId})`);
			lines.push(...indentBlock(clip(r.report, 600) || "(no task report returned)", 600, 6));
		}
	}

	// Where the real outputs live on disk.
	if (meta?.artifacts?.length) {
		lines.push("artifacts:");
		for (const a of meta.artifacts) lines.push(`  - ${a}`);
	}

	// Per-task ledger for traceability — skip leaf tasks already shown in full
	// under "result:" so the deliverable is not printed twice.
	const ledger = results.filter((r) => !leafSet.has(r.taskId));
	if (ledger.length) {
		lines.push("outputs:");
		for (const r of ledger) lines.push(...describeTaskOutput(r, writtenByTask?.get(r.taskId)));
	}

	return { text: lines.join("\n"), tone: degraded.length || skipped.length || blocked.length || errored.length ? "warn" : "ok" };
}

/** Indent a (possibly multi-line) block, capping total length with an ellipsis. */
function indentBlock(text: string, maxLen: number, indent = 2): string[] {
	const trimmed = text.trim();
	const capped = trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed;
	const pad = " ".repeat(indent);
	return capped.split("\n").map((l) => `${pad}${l}`.trimEnd());
}

/** One task's lines for the W4 summary: a header, its deliverable, written files, and details. */
function describeTaskOutput(r: TaskResult, written?: Set<string>): string[] {
	const status = r.status === "ok" ? "ok" : r.status === "blocked" ? "blocked" : r.status;
	const duration = Number.isFinite(r.durationMs) ? ` · ${(r.durationMs / 1000).toFixed(1)}s` : "";
	const lines = [`  - ${r.taskId} (${r.personaId}) ${status}${duration}`];

	const deliverable = clip(summarizeTaskResult(r), 160);
	if (deliverable) lines.push(`      ${deliverable}`);

	const writes = written ? [...written] : [];
	if (writes.length) lines.push(`      writes (${writes.length}): ${clip(writes.join(", "), 200)}`);

	const details: string[] = [];
	if (r.memoryCandidateBody && r.memoryCandidateBody.trim()) details.push("memory candidate");
	if (r.hitStepLimit) details.push("hit step limit");
	if (r.schemaRepairAttempted) details.push("schema repair retried");
	if (r.retryCount !== undefined) details.push(`retries: ${r.retryCount}`);
	if (r.degradedReason) details.push(`degraded: ${clip(r.degradedReason, 60)}`);
	if (r.skipReason) details.push(`skipped: ${clip(r.skipReason, 60)}`);
	if (r.stagingError) details.push(`staging error: ${clip(r.stagingError, 60)}`);
	if (details.length) lines.push(`      details: ${details.join(", ")}`);

	return lines;
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
	if (result.schemaRepairAttempted) lines.push("schema_repair_attempted: true");
	if (result.hitStepLimit !== undefined) lines.push(`hit_step_limit: ${result.hitStepLimit}`);
	if (result.retryCount !== undefined) lines.push(`retry_count: ${result.retryCount}`);
	if (result.degradedReason) lines.push(`degraded_reason: ${result.degradedReason}`);
	if (result.skipReason) lines.push(`skip_reason: ${result.skipReason}`);
	if (result.lastError) lines.push(`last_error: ${result.lastError}`);
	if (result.stagingError) lines.push(`staging_error: ${result.stagingError}`);
	if (Number.isFinite(result.durationMs)) lines.push(`duration_ms: ${result.durationMs}`);
	return lines.join("\n");
}

function summarizeTaskResult(result: TaskResult): string {
	const report = result.report.replace(/\s+/g, " ").trim();
	if (result.errors.length > 0) return result.errors.join("; ");
	if (result.degradedReason) return result.degradedReason;
	if (result.skipReason) return result.skipReason;
	if (report) return report.slice(0, 240);
	return "no detailed task report returned";
}

function renderPipelineHistory(messages: import("../types/common.js").ChatMessage[]): string {
	return messages
		.map((message) => `${message.role.toUpperCase()}: ${String(message.content ?? "").trim()}`)
		.join("\n");
}

function isInternalProcessFile(file: string): boolean {
	const normalized = file.replace(/\\/g, "/");
	return /(^|\/)\.minimum(\/|$)/.test(normalized);
}

function summarizePipelineResult(result: PipelineResult): string {
	const okCount = result.results.filter((item) => item.status === "ok").length;
	const degradedCount = result.results.filter((item) => item.status === "degraded").length;
	const skippedCount = result.results.filter((item) => item.status === "skipped").length;
	const blockedCount = result.results.filter((item) => item.status === "blocked").length;
	const errorCount = result.results.length - okCount - degradedCount - skippedCount - blockedCount;
	const summary = [
		result.ok ? "Pipeline completed." : "Pipeline failed.",
		`Tasks: ${result.results.length} total, ${okCount} ok, ${degradedCount} degraded, ${skippedCount} skipped, ${blockedCount} blocked, ${errorCount} error.`,
		result.statusReason ? `Reason: ${result.statusReason}.` : "",
		result.error ? `Error: ${result.error}` : "",
	]
		.filter(Boolean)
		.join(" ");
	return summary.length <= 400 ? summary : `${summary.slice(0, 397)}...`;
}
