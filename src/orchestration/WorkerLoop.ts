import type {
	IApprovalManager,
	IStreamingClient,
	IToolHost,
} from "../loop/MiMoLoop.js";
import { AgentGitStore, GitSnapshotManager, RunAuditStore, WorktreeIsolator } from "../git/index.js";
import {
	computeTurnCost,
	currencyFor,
	type BillingMode,
	type Currency,
} from "../clients/MiMoPricing.js";
import type { Persona } from "../personas/Persona.js";
import { resolveExecutionBudget, type ExecutionDepth } from "./ExecutionBudget.js";
import { checkWrite } from "../tools/policy/PathPolicyEnforcer.js";
import { checkTool } from "../tools/policy/ToolAllowlistEnforcer.js";
import {
	DEFAULT_MAX_RESULT_BYTES,
	truncateToolResult,
} from "../tools/truncateResult.js";
import type {
	ChatMessage,
	ToolCall,
	ToolDefinition,
} from "../types/common.js";
import type {
	ICodeValidator,
	ValidationResult,
} from "../types/validator.js";
import type { TaskContract } from "./TaskContract.js";
import type { TransactionEvent, TransactionSummary, RepairBudget } from "../transaction/types.js";
import { TaskTransaction } from "../transaction/TaskTransaction.js";
import { resolveFailurePolicy, type PolicyContext } from "../transaction/FailurePolicy.js";
import { buildRepairFeedback } from "../transaction/RepairFeedbackBuilder.js";
import { checkCompletionGate, buildGateBlockMessage } from "../transaction/CompletionGate.js";
import type { ValidationRepairConfig } from "../config/MiMoConfig.js";

const SELF_APPROVING_TOOLS = new Set([
	"shell_fs_read",
	"shell_search",
	"shell_git_read",
	"shell_env_probe",
	"shell_test",
	"shell_typecheck",
	"shell_lint",
	"shell_build",
	"shell_raw",
	"exec_shell",
	"install_dependency",
]);

/**
 * WorkerLoop — multi-turn tool-calling loop for a single sub-agent task.
 *
 * Unlike MiMoLoop (long-lived single-agent session), WorkerLoop is purpose-built
 * for pipeline workers:
 *   • Fresh message history per task — no state leaks between tasks
 *   • Persona-scoped tool surface — only allowlisted tools are advertised
 *   • Contract-scoped write policy — pathPolicy gates every mutating call
 *   • Optional ApprovalManager — when wired, approvalMode (read-only / auto-edit
 *     / full-auto) decides whether a call needs user confirmation
 *   • Compact usage roll-up — accumulated tokens + cost in the active currency
 *
 * The loop stops on any of:
 *   • Model returned content with no further tool_calls (worker is done)
 *   • maxSteps reached (safety bound)
 *   • Abort signal raised
 *   • Streaming error
 */

export type WorkerEvent =
	| { type: "content"; delta: string }
	| { type: "reasoning"; delta: string }
	| { type: "tool_call"; toolName: string; args: string }
	| { type: "tool_result"; toolName: string; ok: boolean; content: string }
	| { type: "tool_denied"; toolName: string; reason: string }
	/** Fired when a write tool's output failed validation and the file was
	 *  rolled back to its pre-edit content. The model sees the validation
	 *  diagnostic via the tool_result message; this is a UI signal. */
	| {
			type: "tool_rolled_back";
			toolName: string;
			path: string;
			restored: boolean;
			issues: number;
	  }
	| { type: "transaction_event"; event: TransactionEvent }
	| { type: "usage"; usage: WorkerUsage };

export interface WorkerUsage {
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
	cachedTokens: number;
	reasoningTokens: number;
	totalCost: number;
	currency: Currency;
	toolCalls: number;
	steps: number;
}

export interface WorkerLoopOptions {
	client: IStreamingClient;
	tools: IToolHost;
	approvalManager?: IApprovalManager;
	projectRoot: string;
	model?: string;
	billingMode?: BillingMode;
	/** Cap on tool-result byte size before injection into the next prompt. */
	maxToolResultBytes?: number;
	/**
	 * Optional validator (typically the same CodeValidator the single-agent
	 * MiMoLoop uses). When wired, writes that fail tsc/syntax/pattern checks
	 * are rolled back to their pre-edit content via SnapshotManager and the
	 * model is fed the diagnostic so it can self-correct.
	 */
	validator?: ICodeValidator;
	/**
	 * When true, each task gets an isolated git worktree.
	 * All LLM tool writes are routed to the worktree path; on completion the
	 * changes are committed and applied back to `projectRoot`.
	 */
	worktreeIsolation?: boolean;
	/**
	 * Validation repair loop configuration. When provided, validation failures
	 * are recorded in a TaskTransaction with structured repair feedback instead
	 * of immediate rollback. The repair budget limits how many fix attempts
	 * are allowed before the transaction is marked failed.
	 */
	transactionConfig?: ValidationRepairConfig;
	/**
	 * Pipeline-scoped run identifier. When provided, all tasks share the same
	 * runId so they can fork worktrees from a run-level integrated ref.
	 * When omitted, each task generates its own (legacy behaviour).
	 */
	runId?: string;
}

export interface WorkerRunInput {
	systemPrompt: string;
	userPrompt: string;
	persona: Persona;
	contract: TaskContract;
	maxSteps?: number;
	maxTokens?: number;
	executionDepth?: ExecutionDepth;
	signal?: AbortSignal;
	onEvent?: (event: WorkerEvent) => void;
	/**
	 * Plan-mode turn: strip every mutating tool (writes, shell exec, installs) so
	 * the worker can only read while proposing an <execution_plan>. The model
	 * never sees a tool it could use to change the workspace.
	 */
	readOnly?: boolean;
	/** Pipeline-scoped run id — takes precedence over the constructor-level runId. */
	runId?: string;
}

export interface WorkerRunResult {
	/** Final assistant text — typically contains a <task_report> block. */
	text: string;
	usage: WorkerUsage;
	/** True if the loop exited because maxSteps was reached without a final answer. */
	hitStepLimit: boolean;
	/** True when the final worker turn ended with no content and no tool calls. */
	emptyFinalTurn?: boolean;
	/** Structured reason for the terminal state. */
	finishReason: "final" | "empty_stream" | "step_limit";
	/** Transaction summary recording all validation events, repairs, and file touches. */
	transactionSummary?: TransactionSummary;
	/** Worktree conflict records from apply-back (files deferred to W4 merge). */
	worktreeConflicts?: Array<{ path: string; baseSha: string; taskCommitSha: string }>;
}

const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "apply_patch"]);

const CHECKABLE_SHELL_TOOLS: Record<string, "test" | "build" | "lint" | "typecheck"> = {
	"shell_test": "test",
	"shell_build": "build",
	"shell_lint": "lint",
	"shell_typecheck": "typecheck",
};

/** Tools that can mutate the workspace/environment — denied during a plan turn. */
const MUTATING_TOOL_NAMES = new Set([
	"write_file", "edit_file", "apply_patch",
	"exec_shell", "shell_raw", "shell_test", "shell_typecheck", "shell_lint", "shell_build",
	"install_dependency", "run_background", "stop_job", "git",
]);

/** Whether a tool can change files or the environment (so a read-only plan turn forbids it). */
export function isMutatingTool(name: string): boolean {
	return MUTATING_TOOL_NAMES.has(name);
}

/**
 * Tools a persona may invoke for a task: its static allowlist, plus the MCP
 * tools the master granted this task — minus anything in the persona's denylist
 * (a grant never overrides a denylist). Pure, so tool selection is unit-testable
 * without driving a full worker loop.
 */
export function selectPersonaTools(
	allTools: ToolDefinition[],
	persona: Persona,
	grantedMcpTools: string[],
	contract?: TaskContract,
): ToolDefinition[] {
	const granted = new Set(grantedMcpTools);
	return allTools.filter(
		(t) =>
			checkTool(t.name, persona).ok ||
			(allowPostStaticCompileShell(t.name, persona, contract) ?? false) ||
			(granted.has(t.name) && !persona.toolDenylist.includes(t.name)),
	);
}

export class WorkerLoop {
	private readonly client: IStreamingClient;
	private readonly tools: IToolHost;
	private readonly approvalManager?: IApprovalManager;
	private readonly validator?: ICodeValidator;
	private readonly projectRoot: string;
	private readonly model: string;
	private readonly billingMode: BillingMode;
	private readonly maxToolResultBytes: number;
	private readonly worktreeIsolation: boolean;
	private readonly transactionConfig: ValidationRepairConfig | undefined;
	private readonly runId: string | undefined;

	constructor(opts: WorkerLoopOptions) {
		this.client = opts.client;
		this.tools = opts.tools;
		this.approvalManager = opts.approvalManager;
		this.validator = opts.validator;
		this.projectRoot = opts.projectRoot;
		this.model = opts.model ?? "mimo-v2.5-pro";
		this.billingMode = opts.billingMode ?? "api";
		this.maxToolResultBytes = opts.maxToolResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
		this.worktreeIsolation = opts.worktreeIsolation ?? false;
		this.transactionConfig = opts.transactionConfig;
		this.runId = opts.runId;
	}

	async runTask(input: WorkerRunInput): Promise<WorkerRunResult> {
		const budget = resolveExecutionBudget(input.persona.id, input.executionDepth);
		const maxSteps = input.maxSteps ?? budget.maxSteps;
		const maxTokens = input.maxTokens ?? budget.maxTokens;
		const emit = input.onEvent ?? (() => {});

		// Filter the host's tool catalog down to what this persona may invoke,
		// plus any MCP tools the master granted this task. The model never even
		// sees a tool it cannot invoke.
		const allTools = this.tools.getDefinitions();
		const selectedTools = selectPersonaTools(
			allTools,
			input.persona,
			input.contract.grantedMcpTools ?? [],
			input.contract,
		);
		// Plan-mode turns are read-only: hide every mutating tool from the model.
		const personaTools = input.readOnly
			? selectedTools.filter((t) => !isMutatingTool(t.name))
			: selectedTools;
		const pendingStaticCompileCommands = new Set(
			input.contract.postStaticCompile?.required
				? input.contract.postStaticCompile.commands
				: [],
		);

		// Per-task snapshot scope. Each runTask gets its own GitSnapshotManager so
		// rollbacks from task A can't undo task B's edits when they run in
		// parallel via the dynamic harness. The instance lives only for the duration
		// of this call.
		const gitStore = await AgentGitStore.resolve(this.projectRoot);
		const runId = input.runId ?? this.runId ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
		const snapshots = new GitSnapshotManager(gitStore, runId, input.contract.taskId);

		// Worktree isolation lifecycle — create before task, commit+apply after.
		let worktreeBaseSha: string | null = null;
		let activeWorktreePath: string | undefined;
		const isolator = this.worktreeIsolation
			? new WorktreeIsolator(gitStore)
			: null;

		if (isolator) {
			try {
				const integratedRef = `refs/minimum/${runId}/integrated`;
				worktreeBaseSha = (await gitStore.readRef(integratedRef)) ?? (await gitStore.readRef("HEAD"));
				if (!worktreeBaseSha) {
					// Repo has no HEAD (empty) — make a root commit so we have a base SHA.
					worktreeBaseSha = await gitStore.commitTree(
						[{ relativePath: ".minimum-init", content: "" }],
						"chore: initialize minimum object store",
					);
					await gitStore.setRef("refs/minimum/init", worktreeBaseSha);
				}
				activeWorktreePath = await isolator.create(input.contract.taskId, worktreeBaseSha);
			} catch {
				// Worktree creation failed — proceed without isolation.
				worktreeBaseSha = null;
				activeWorktreePath = undefined;
			}
		}

		// Task transaction — records touched files, validation failures, and repair
		// history. Only created when transactionConfig is wired (repair loop enabled).
		const txEnabled = this.transactionConfig?.enabled !== false;
		const transaction = txEnabled
			? new TaskTransaction(
					{
						taskId: input.contract.taskId,
						personaId: input.persona.id,
						objective: input.contract.objective,
						acceptance: input.contract.acceptance,
						allowedGlobs: input.contract.pathPolicy.allowedGlobs,
						baseRevision: worktreeBaseSha,
						worktreePath: activeWorktreePath,
					},
					{
						maxAttemptsPerFile: this.transactionConfig?.maxAttemptsPerFile,
						maxAttemptsPerTask: this.transactionConfig?.maxAttemptsPerTask,
						sameErrorRepeatLimit: this.transactionConfig?.sameErrorRepeatLimit,
						maxDiffChars: this.transactionConfig?.maxDiffChars,
						maxDiagnosticChars: this.transactionConfig?.maxDiagnosticChars,
					},
				)
			: null;

		if (transaction) {
			transaction.onEvent((evt) => emit({ type: "transaction_event", event: evt }));
		}

		const messages: ChatMessage[] = [
			{ role: "system", content: input.systemPrompt },
			{ role: "user", content: input.userPrompt },
		];

		const usage: WorkerUsage = {
			totalTokens: 0,
			promptTokens: 0,
			completionTokens: 0,
			cachedTokens: 0,
			reasoningTokens: 0,
			totalCost: 0,
			currency: currencyFor(this.billingMode),
			toolCalls: 0,
			steps: 0,
		};

		let finalContent = "";
		let hitStepLimit = true;
		let emptyFinalTurn = false;
		let finishReason: WorkerRunResult["finishReason"] = "step_limit";

		for (let step = 0; step < maxSteps; step++) {
			if (input.signal?.aborted) break;
			usage.steps = step + 1;

			const turn = await this.streamOneTurn(
				messages,
				personaTools,
				maxTokens,
				input.signal,
				emit,
			);
			this.foldUsage(usage, turn);

			// Record the assistant turn (content + tool_calls) into the transcript
			// so the next iteration sees a coherent history.
			messages.push({
				role: "assistant",
				content: turn.content,
				...(turn.toolCalls.length > 0 ? { tool_calls: turn.toolCalls } : {}),
			});

			if (turn.toolCalls.length === 0) {
				if (pendingStaticCompileCommands.size > 0) {
					messages.push({
						role: "user",
						content: [
							"Static compile is still required before you may finish this task.",
							`Run and pass these command(s): ${[...pendingStaticCompileCommands].join("; ")}`,
							"Do not finalize yet. Continue the task until those commands pass, then re-emit the final <task_report>.",
						].join("\n"),
					});
					finalContent = turn.content;
					continue;
				}
				// No more tool calls → model has produced its final answer.
				finalContent = turn.content;
				hitStepLimit = false;
				emptyFinalTurn = !turn.content.trim();
				finishReason = emptyFinalTurn ? "empty_stream" : "final";
				break;
			}

			// Process each tool call sequentially. The model expects one tool
			// message per tool_call id, in order, before the next assistant turn.
			for (const call of turn.toolCalls) {
				if (input.signal?.aborted) break;
				const outcome = await this.executeOne(
					call,
					input.persona,
					input.contract,
					input.signal,
					snapshots,
					emit,
					pendingStaticCompileCommands,
					activeWorktreePath,
					transaction,
				);
				usage.toolCalls += 1;

				if (outcome.kind === "denied") {
					emit({
						type: "tool_denied",
						toolName: call.function.name,
						reason: outcome.reason,
					});
					messages.push({
						role: "tool",
						content: `Denied: ${outcome.reason}`,
						tool_call_id: call.id,
					});
					continue;
				}

				const truncated = truncateToolResult(
					outcome.content,
					this.maxToolResultBytes,
				);
				emit({
					type: "tool_result",
					toolName: call.function.name,
					ok: !outcome.isError,
					content: truncated,
				});
				messages.push({
					role: "tool",
					content: truncated,
					tool_call_id: call.id,
				});

				// Inject repair feedback as a user message when a validation
				// failure was recorded and the transaction entered repair mode.
				if (outcome.repairFeedback) {
					messages.push({
						role: "user",
						content: outcome.repairFeedback,
					});
					transaction?.emitRepairEvent({
						type: "repair_feedback_injected",
						attemptIndex: transaction.repairAttempts,
					});
				}
			}
		}

		// If the loop ended on step limit, prefer the last assistant content
		// over an empty string so callers still see whatever partial output
		// the worker produced.
		if (hitStepLimit && !finalContent) {
			const lastAssistant = [...messages]
				.reverse()
				.find((m) => m.role === "assistant");
			finalContent =
				typeof lastAssistant?.content === "string" ? lastAssistant.content : "";
		}
		if (pendingStaticCompileCommands.size > 0) {
			finalContent = [
				"<task_report>",
				"  <status>failed</status>",
				`  <summary>Static compile did not pass before task completion. Pending commands: ${[...pendingStaticCompileCommands].join("; ")}</summary>`,
				"</task_report>",
			].join("\n");
			hitStepLimit = false;
			finishReason = "final";
		}

		if (hitStepLimit) {
			finishReason = "step_limit";
		}
		emit({ type: "usage", usage });

		// Completion gate — prevent workers from reporting completed while
		// unresolved validation failures exist in the transaction.
		if (transaction && this.transactionConfig?.blockCompletedWithPendingFailures !== false) {
			const reportStatus = extractReportStatus(finalContent);
			const budgetRemaining = transaction.getRemainingBudget();
			const gate = checkCompletionGate(
				transaction.status,
				reportStatus,
				transaction.hasUnresolvedFailures(),
				budgetRemaining.perTask <= 0,
			);
			if (!gate.allow) {
				const blockMsg = buildGateBlockMessage(
					gate,
					transaction.status,
					transaction.failures.filter((f) => !f.resolved).length,
					budgetRemaining.perTask,
				);
				finalContent = [
					"<task_report>",
					`  <status>${gate.requiredAction === "repair" ? "failed" : "blocked"}</status>`,
					`  <summary>${blockMsg}</summary>`,
					"</task_report>",
				].join("\n");
				finishReason = "final";
				hitStepLimit = false;
				transaction.setRollbackReason(gate.reason);
				if (gate.requiredAction === "blocked_or_failed") {
					try { transaction.transitionTo("blocked"); } catch { /* already terminal */ }
				} else {
					try { transaction.transitionTo("failed"); } catch { /* already terminal */ }
				}
			}
		}

		// Worktree isolation: commit changes from worktree and apply to main tree.
		// When a transaction is active, only apply if the transaction is validated
		// (no unresolved failures). Otherwise discard the worktree.
		let worktreeApplyConflicts: Array<{ path: string; baseSha: string; taskCommitSha: string }> | undefined;
		if (isolator && worktreeBaseSha) {
			if (transaction && !transaction.hasUnresolvedFailures() && !transaction.isTerminal) {
				try {
					transaction.transitionTo("validated");
				} catch { /* may already be validated */ }
			}
			const shouldApply = !transaction || transaction.status === "validated";
			if (shouldApply) {
				const integratedRef = `refs/minimum/${runId}/integrated`;
				try {
					const result = await isolator.commitAndApply(
						input.contract.taskId,
						worktreeBaseSha,
						`task(${input.contract.taskId}): apply worktree changes`,
					);
					if (transaction) {
						transaction.setCommitSha(result?.sha ?? null);
						try { transaction.transitionTo("committed"); } catch { /* already terminal */ }
					}
					if (result?.conflicts?.length) {
						worktreeApplyConflicts = result.conflicts;
					}
					// Advance the run's integrated ref so later tasks fork from a
					// tree that includes this task's applied (non-conflicting)
					// changes. CAS-retry serialises against concurrent task
					// completions.
					if (result?.sha && worktreeBaseSha) {
						for (let attempt = 0; attempt < 5; attempt++) {
							const currentRef = await gitStore.readRef(integratedRef);
							const current = currentRef ?? worktreeBaseSha;
							const casOld = currentRef ?? "";
							try {
								const overlay = await gitStore.overlayCommit(
									current,
									result.sha,
									worktreeBaseSha,
									`integrate(${input.contract.taskId})`,
								);
								if (await gitStore.compareAndSwapRef(integratedRef, casOld, overlay.sha)) break;
							} catch {
								break;
							}
						}
					}
				} catch {
					// commitAndApply failed — transaction stays validated (not committed)
				}
				void isolator.discard(input.contract.taskId).catch(() => {});
			} else {
				transaction?.setRollbackReason("unresolved validation failures");
				try { transaction?.transitionTo("rolled_back"); } catch { /* already terminal */ }
				void isolator.discard(input.contract.taskId).catch(() => {});
			}
		}

		// Fire-and-forget: record task-done checkpoint for run history.
		void new RunAuditStore(gitStore)
			.setCheckpoint(runId, `task/${input.contract.taskId}/done`)
			.catch(() => {}); // audit failure must never affect task outcome

		return {
			text: finalContent,
			usage,
			hitStepLimit,
			...(emptyFinalTurn && { emptyFinalTurn }),
			finishReason,
			...(transaction && { transactionSummary: transaction.getSummary() }),
			...(worktreeApplyConflicts?.length && { worktreeConflicts: worktreeApplyConflicts }),
		};
	}

	// ── internals ───────────────────────────────────────────────────────────

	private async streamOneTurn(
		messages: ChatMessage[],
		personaTools: ToolDefinition[],
		maxTokens: number | undefined,
		signal: AbortSignal | undefined,
		emit: (e: WorkerEvent) => void,
	): Promise<TurnOutcome> {
		const stream = this.client.streamChat({
			messages,
			tools: personaTools.length > 0 ? personaTools : undefined,
			...(maxTokens !== undefined && { maxTokens }),
			...(signal !== undefined && { signal }),
		});

		let content = "";
		const partials = new Map<number, ToolCall>();
		let lastTurnUsage:
			| {
					promptTokens: number;
					completionTokens: number;
					totalTokens: number;
					cachedTokens: number;
					reasoningTokens: number;
			  }
			| undefined;

		for await (const chunk of stream) {
			switch (chunk.type) {
				case "content":
					if (chunk.content) {
						content += chunk.content;
						emit({ type: "content", delta: chunk.content });
					}
					break;
				case "reasoning":
					if (chunk.content) {
						emit({ type: "reasoning", delta: chunk.content });
					}
					break;
				case "tool_call":
					if (chunk.toolCall) {
						const tc = chunk.toolCall;
						const existing = partials.get(0); // sequential — single call at a time per stream chunk
						// MiMoClient already coalesces partial tool_call chunks into
						// complete ToolCall objects via the id-bearing first chunk,
						// so we receive them whole here.
						const idx = existing ? partials.size : partials.size;
						partials.set(idx, tc);
						emit({
							type: "tool_call",
							toolName: tc.function.name,
							args: tc.function.arguments || "",
						});
					}
					break;
				case "usage":
					if (chunk.usage) {
						lastTurnUsage = {
							promptTokens: chunk.usage.promptTokens || 0,
							completionTokens: chunk.usage.completionTokens || 0,
							totalTokens: chunk.usage.totalTokens || 0,
							cachedTokens: chunk.usage.cachedTokens || 0,
							reasoningTokens: chunk.usage.reasoningTokens || 0,
						};
					}
					break;
				case "error":
					throw new Error(chunk.error || "worker stream error");
				case "done":
					break;
			}
		}

		return {
			content,
			toolCalls: [...partials.values()],
			usage: lastTurnUsage,
		};
	}

	private foldUsage(into: WorkerUsage, turn: TurnOutcome): void {
		if (!turn.usage) return;
		const { cost } = computeTurnCost(
			{
				promptTokens: turn.usage.promptTokens,
				completionTokens: turn.usage.completionTokens,
				cachedTokens: turn.usage.cachedTokens,
			},
			this.model,
			this.billingMode,
		);
		into.totalTokens += turn.usage.totalTokens;
		into.promptTokens += turn.usage.promptTokens;
		into.completionTokens += turn.usage.completionTokens;
		into.cachedTokens += turn.usage.cachedTokens;
		into.reasoningTokens += turn.usage.reasoningTokens;
		into.totalCost += cost;
	}

	private async executeOne(
		call: ToolCall,
		persona: Persona,
		contract: TaskContract,
		signal: AbortSignal | undefined,
		snapshots: GitSnapshotManager,
		emit: (e: WorkerEvent) => void,
		pendingStaticCompileCommands: Set<string>,
		worktreePath?: string,
		transaction?: TaskTransaction | null,
	): Promise<ExecuteOutcome> {
		const effectiveRoot = worktreePath ?? this.projectRoot;
		const name = call.function.name;

		// Defense-in-depth: the model can hallucinate a tool name that isn't in
		// its prompt. Deny before we ever reach the tool host.
		const tool = checkTool(name, persona);
		const allowStaticCompileShell = allowPostStaticCompileShell(name, persona, contract);
		if (!tool.ok && !allowStaticCompileShell) {
			return { kind: "denied", reason: tool.reason };
		}

		const args = safeParseArgs(call);
		if (allowStaticCompileShell) {
			const command = typeof args.command === "string" ? args.command.trim() : "";
			if (!command || !pendingStaticCompileCommands.has(command)) {
				return {
					kind: "denied",
					reason: `exec_shell is restricted to configured static compile commands: ${(contract.postStaticCompile?.commands ?? []).join("; ")}`,
				};
			}
		}
		const isWrite = WRITE_TOOL_NAMES.has(name);
		const targetPath =
			isWrite && typeof args.path === "string" ? args.path : "";

		// Write-policy gate. Path-mutating tools fail closed against
		// persona.alwaysAllowedGlobs ∪ contract.allowedGlobs.
		if (isWrite) {
			if (!targetPath) {
				return {
					kind: "denied",
					reason: `${name} requires a path argument`,
				};
			}
			const decision = checkWrite(targetPath, {
				persona,
				contract,
				projectRoot: effectiveRoot,
			});
			if (!decision.ok) {
				return { kind: "denied", reason: decision.reason };
			}
		}

		// install_dependency writes manifest/lockfile targets — verify they're
		// within the contract's allowed paths before execution.
		if (name === "install_dependency") {
			const { dependencyWriteTargets } = await import("../tools/shell/InstallDependencyTool.js");
			const writeTargets = dependencyWriteTargets(args, effectiveRoot);
			for (const target of writeTargets) {
				const decision = checkWrite(target, {
					persona,
					contract,
					projectRoot: effectiveRoot,
				});
				if (!decision.ok) {
					return {
						kind: "denied",
						reason: `install_dependency: write target "${target}" not in allowedGlobs — ${decision.reason}`,
					};
				}
			}
		}

		// Approval gate — only when an ApprovalManager is wired. The TUI's
		// approvalMode (read-only / auto-edit / full-auto) lives inside this
		// manager and decides whether the call needs a user confirmation.
		// Shell tools (shell_*, exec_shell, install_dependency) manage their
		// own approval internally and are skipped here.
		if (this.approvalManager && !SELF_APPROVING_TOOLS.has(name)) {
			try {
				const request = await this.approvalManager.requestApproval(
					name,
					args,
					`Execute ${name}`,
				);
				const verdict = await this.approvalManager.checkApproval(request);
				if (!verdict.approved) {
					return {
						kind: "denied",
						reason: verdict.reason ?? "approval denied",
					};
				}
			} catch (err) {
				return {
					kind: "denied",
					reason: err instanceof Error ? err.message : String(err),
				};
			}
		}

		// Snapshot pre-edit state so a tsc/syntax/pattern failure can roll back.
		// We snapshot even when no validator is wired so future runs with one
		// would still be able to restore (cheap — one fs.readFile per file).
		if (isWrite && targetPath) {
			await snapshots.snapshot(targetPath, effectiveRoot);
			if (transaction) {
				transaction.touchFile(targetPath, "modified");
			}
		}

		// Execute the tool itself.
		let executed: { content: string; isError: boolean };
		try {
			const result = await this.tools.execute(call, {
				...(signal !== undefined && { signal }),
				workingDirectory: effectiveRoot,
			});
			executed = {
				content: result.content,
				isError: result.isError ?? false,
			};
		} catch (err) {
			executed = {
				content: err instanceof Error ? err.message : String(err),
				isError: true,
			};
		}

		// Post-edit validation. Only runs on successful writes (the model
		// shouldn't be told the file is broken when its own call already
		// failed). When a transaction is active, failures are recorded with
		// structured diagnostics and repair feedback; without a transaction,
		// the legacy immediate-rollback behaviour is preserved.
		let repairFeedback: string | undefined;
		if (
			this.validator &&
			isWrite &&
			targetPath &&
			!executed.isError
		) {
			const validation = await this.runValidator(
				name,
				args,
				executed,
				targetPath,
				effectiveRoot,
			);
			if (validation && !validation.passed) {
				const issues = validation.checks.filter((c) => !c.passed);

				if (transaction) {
					// Transaction-aware validation: resolve policy, record failure,
					// conditionally rollback, and build repair feedback.
					const hasWorktree = !!worktreePath;
					const policy = resolveFailurePolicy({
						checkerType: issues[0]?.type === "type" ? "typecheck"
							: issues[0]?.type === "pattern" ? "pattern"
							: "syntax",
						severity: issues.some((i) => i.severity === "error") ? "error" : "warning",
						hasWorktree,
						isPathPolicyViolation: false,
						isForbiddenGlob: false,
					});

					const diagEntries = issues.map((c) => ({
						file: c.location?.file ?? targetPath,
						line: c.location?.line,
						column: c.location?.column,
						message: c.message,
						errorCode: c.name,
					}));

					// Capture diff before rollback if policy requires it.
					let failedDiff: string | null = null;
					if (policy === "rollback_with_diff" || this.transactionConfig?.includeFailedDiff) {
						try {
							const { readFileSync } = await import("node:fs");
							const currentContent = readFileSync(
								`${effectiveRoot}/${targetPath}`,
								"utf-8",
							);
							failedDiff = currentContent.slice(0, transaction.repairBudget.maxDiffChars);
						} catch {
							failedDiff = null;
						}
					}

					const wasRepairing = transaction.status === "repairing";
					const failure = transaction.recordFailure({
						checkerType: issues[0]?.type === "type" ? "typecheck"
							: issues[0]?.type === "pattern" ? "pattern"
							: "syntax",
						severity: issues.some((i) => i.severity === "error") ? "error" : "warning",
						affectedFiles: [targetPath],
						diagnostics: diagEntries,
						failedDiff,
						policy,
					});
					if (wasRepairing) {
						transaction.emitRepairEvent({
							type: "repair_attempt_failed",
							attemptIndex: transaction.repairAttempts,
							failure,
						});
					}

					// Execute policy action.
					if (policy === "rollback_with_diff" || policy === "terminate") {
						const restored = await snapshots.restore(targetPath, effectiveRoot);
						emit({
							type: "tool_rolled_back",
							toolName: name,
							path: targetPath,
							restored,
							issues: issues.length,
						});
					}
					// retain_and_repair: keep the failed edit in the worktree.
					// feedback_only: don't rollback, just record.

					if (policy !== "feedback_only" && policy !== "terminate") {
						const canRepair = transaction.canRepair(targetPath);
						if (canRepair.allowed) {
							const errorSig = `${failure.checkerType}:${targetPath}:${issues[0]?.name ?? ""}:${issues[0]?.location?.line ?? 0}`;
							if (!transaction.checkSameErrorRepeat(errorSig)) {
								transaction.consumeRepairAttempt(targetPath, errorSig);
								repairFeedback = buildRepairFeedback({
									objective: transaction.objective,
									acceptance: transaction.acceptance,
									failure,
									failedDiff,
									touchedFiles: [...transaction.touchedFiles.keys()],
									remainingBudget: transaction.getRemainingBudget(),
									allowedGlobs: transaction.allowedGlobs,
									maxDiffChars: transaction.repairBudget.maxDiffChars,
									maxDiagnosticChars: transaction.repairBudget.maxDiagnosticChars,
								});
							}
						}
					}

					// Terminate policy: force transaction failure.
					if (policy === "terminate") {
						transaction.setRollbackReason(`policy violation: ${failure.checkerType}`);
						try { transaction.transitionTo("failed"); } catch { /* already terminal */ }
					}

					// Update the tool result with diagnostic info.
					const diagLines = issues
						.map((c) => {
							const loc = c.location
								? `${c.location.file}(${c.location.line},${c.location.column}): `
								: "";
							return `  ${loc}${c.message}`;
						})
						.join("\n");
					const policyNote = policy === "retain_and_repair"
						? "\nFailed edit retained for repair. See repair feedback above."
						: policy === "rollback_with_diff"
							? "\nFile has been restored to its pre-edit state. Failed diff retained for repair."
							: policy === "terminate"
								? "\nPolicy violation — task terminated."
								: "\nWarning (non-blocking).";
					executed = {
						content: [
							executed.content,
							"",
							`Validation failed with ${issues.length} issue(s):`,
							diagLines,
							policyNote,
						].join("\n").trim(),
						isError: policy !== "feedback_only",
					};
				} else {
					// Legacy path: no transaction — immediate rollback.
					const restored = await snapshots.restore(
						targetPath,
						effectiveRoot,
					);
					const diagLines = issues
						.map((c) => {
							const loc = c.location
								? `${c.location.file}(${c.location.line},${c.location.column}): `
								: "";
							return `  ${loc}${c.message}`;
						})
						.join("\n");
					executed = {
						content: [
							executed.content,
							"",
							`Validation failed with ${issues.length} issue(s):`,
							diagLines,
							restored
								? "\nFile has been restored to its pre-edit state."
								: "\nWarning: rollback failed; file may be in a partial state.",
						]
							.join("\n")
							.trim(),
						isError: true,
					};
					emit({
						type: "tool_rolled_back",
						toolName: name,
						path: targetPath,
						restored,
						issues: issues.length,
					});
				}
			} else if (validation?.passed && transaction && transaction.hasUnresolvedFailures()) {
				const resolved = transaction.resolveFailuresForFile(targetPath);
				for (let i = 0; i < resolved; i++) {
					transaction.emitRepairEvent({
						type: "repair_attempt_passed",
						attemptIndex: transaction.repairAttempts,
					});
				}
			}
		}
		// Post-shell failure detection. When a checkable shell tool (test/build/lint/
		// typecheck) runs, feed success/failure into the transaction so the repair loop
		// and completion gate cover runtime failures, not just post-write static checks.
		const shellCheckerType = CHECKABLE_SHELL_TOOLS[name];
		if (shellCheckerType && transaction) {
			const shellExitCode = parseShellExitCode(executed.content);
			const shellFailed = shellExitCode !== null && shellExitCode !== 0;
			if (shellFailed) {
				const command = typeof args.command === "string" ? args.command : name;
				const hadUnresolved = transaction.failures.some(
					(f) => !f.resolved && f.checkerType === shellCheckerType,
				);
				const shellFailure = transaction.recordFailure({
					checkerType: shellCheckerType,
					severity: "error",
					affectedFiles: transaction.touchedFiles.size > 0 ? [...transaction.touchedFiles.keys()] : [command],
					diagnostics: [{
						file: "",
						message: name + " failed (exit " + shellExitCode + "): " + command,
					}],
					failedDiff: executed.content.slice(0, transaction.repairBudget.maxDiffChars),
					command,
					exitCode: shellExitCode ?? undefined,
					policy: "retain_and_repair",
				});
				if (hadUnresolved) {
					transaction.emitRepairEvent({
						type: "repair_attempt_failed",
						attemptIndex: transaction.repairAttempts,
						failure: shellFailure,
					});
				}
				const shellCanRepair = transaction.canRepair(shellCheckerType);
				if (shellCanRepair.allowed) {
					const shellErrorSig = shellCheckerType + ":" + command;
					if (!transaction.checkSameErrorRepeat(shellErrorSig)) {
						transaction.consumeRepairAttempt(shellCheckerType, shellErrorSig);
						repairFeedback = buildRepairFeedback({
							objective: transaction.objective,
							acceptance: transaction.acceptance,
							failure: shellFailure,
							failedDiff: shellFailure.failedDiff,
							touchedFiles: [...transaction.touchedFiles.keys()],
							remainingBudget: transaction.getRemainingBudget(),
							allowedGlobs: transaction.allowedGlobs,
							maxDiffChars: transaction.repairBudget.maxDiffChars,
							maxDiagnosticChars: transaction.repairBudget.maxDiagnosticChars,
						});
					}
				}
			} else if (shellExitCode === 0 && transaction.hasUnresolvedFailures()) {
				const resolved = transaction.resolveFailuresByCheckerType(shellCheckerType);
				for (let i = 0; i < resolved; i++) {
					transaction.emitRepairEvent({
						type: "repair_attempt_passed",
						attemptIndex: transaction.repairAttempts,
					});
				}
			}
		}
		if (
			allowStaticCompileShell &&
			!executed.isError &&
			typeof args.command === "string"
		) {
			pendingStaticCompileCommands.delete(args.command.trim());
		}

		return {
			kind: "executed",
			content: executed.content,
			isError: executed.isError,
			repairFeedback,
		};
	}

	private async runValidator(
		toolName: string,
		args: Record<string, unknown>,
		result: { content: string; isError: boolean },
		filePath: string,
		workingDirectory: string,
	): Promise<ValidationResult | undefined> {
		if (!this.validator) return undefined;
		try {
			return await this.validator.validate({
				toolName,
				toolArgs: args,
				toolResult: result,
				filePath,
				workingDirectory,
			});
		} catch {
			// Validator faults must not nuke the worker — treat as a pass.
			return undefined;
		}
	}
}

interface TurnOutcome {
	content: string;
	toolCalls: ToolCall[];
	usage?:
		| {
				promptTokens: number;
				completionTokens: number;
				totalTokens: number;
				cachedTokens: number;
				reasoningTokens: number;
		  }
		| undefined;
}

type ExecuteOutcome =
	| { kind: "denied"; reason: string }
	| { kind: "executed"; content: string; isError: boolean; repairFeedback?: string };

function safeParseArgs(call: ToolCall): Record<string, unknown> {
	const raw = call.function.arguments;
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function allowPostStaticCompileShell(
	toolName: string,
	persona: Persona,
	contract: TaskContract | undefined,
): boolean {
	return (
		toolName === "exec_shell" &&
		persona.pathPolicy.canWrite &&
		contract?.postStaticCompile?.required === true
	);
}

/** Extract the <status> value from a task_report in the worker's final content. */
function extractReportStatus(text: string): string | undefined {
	const reportMatch = text.match(/<\s*task_report[^>]*>([\s\S]*?)<\s*\/\s*task_report\s*>/);
	if (!reportMatch) return undefined;
	const statusMatch = reportMatch[1]?.match(/<\s*status\s*>\s*(.*?)\s*<\s*\/\s*status\s*>/);
	return statusMatch?.[1]?.trim();
}

export function parseShellExitCode(content: string): number | null {
	const m = content.match(/\[exit\s+(\d+)\]/);
	if (m?.[1] !== undefined) return parseInt(m[1], 10);
	if (content.includes("[killed after timeout]")) return -1;
	return null;
}
