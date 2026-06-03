import type {
	IApprovalManager,
	IStreamingClient,
	IToolHost,
} from "../loop/MiMoLoop.js";
import { SnapshotManager } from "../loop/SnapshotManager.js";
import {
	computeTurnCost,
	currencyFor,
	type BillingMode,
	type Currency,
} from "../clients/MiMoPricing.js";
import type { Persona } from "../personas/Persona.js";
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
}

export interface WorkerRunInput {
	systemPrompt: string;
	userPrompt: string;
	persona: Persona;
	contract: TaskContract;
	maxSteps?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	onEvent?: (event: WorkerEvent) => void;
}

export interface WorkerRunResult {
	/** Final assistant text — typically contains a <task_report> block. */
	text: string;
	usage: WorkerUsage;
	/** True if the loop exited because maxSteps was reached without a final answer. */
	hitStepLimit: boolean;
}

const WRITE_TOOL_NAMES = new Set(["write_file", "edit_file", "apply_patch"]);

export class WorkerLoop {
	private readonly client: IStreamingClient;
	private readonly tools: IToolHost;
	private readonly approvalManager?: IApprovalManager;
	private readonly validator?: ICodeValidator;
	private readonly projectRoot: string;
	private readonly model: string;
	private readonly billingMode: BillingMode;
	private readonly maxToolResultBytes: number;

	constructor(opts: WorkerLoopOptions) {
		this.client = opts.client;
		this.tools = opts.tools;
		this.approvalManager = opts.approvalManager;
		this.validator = opts.validator;
		this.projectRoot = opts.projectRoot;
		this.model = opts.model ?? "mimo-v2.5-pro";
		this.billingMode = opts.billingMode ?? "api";
		this.maxToolResultBytes = opts.maxToolResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
	}

	async runTask(input: WorkerRunInput): Promise<WorkerRunResult> {
		const maxSteps = input.maxSteps ?? input.persona.maxSteps ?? 20;
		const maxTokens = input.maxTokens ?? input.persona.maxTokens;
		const emit = input.onEvent ?? (() => {});

		// Filter the host's tool catalog down to what this persona may invoke.
		// Model never even sees the denied/non-allowlisted tools.
		const allTools = this.tools.getDefinitions();
		const personaTools = allTools.filter((t) =>
			checkTool(t.name, input.persona).ok,
		);

		// Per-task snapshot scope. Each runTask gets its own SnapshotManager so
		// rollbacks from task A can't undo task B's edits when they run in
		// parallel via WaveScheduler. The instance lives only for the duration
		// of this call.
		const snapshots = new SnapshotManager();

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
				// No more tool calls → model has produced its final answer.
				finalContent = turn.content;
				hitStepLimit = false;
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

		emit({ type: "usage", usage });
		return { text: finalContent, usage, hitStepLimit };
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
		snapshots: SnapshotManager,
		emit: (e: WorkerEvent) => void,
	): Promise<ExecuteOutcome> {
		const name = call.function.name;

		// Defense-in-depth: the model can hallucinate a tool name that isn't in
		// its prompt. Deny before we ever reach the tool host.
		const tool = checkTool(name, persona);
		if (!tool.ok) {
			return { kind: "denied", reason: tool.reason };
		}

		const args = safeParseArgs(call);
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
				projectRoot: this.projectRoot,
			});
			if (!decision.ok) {
				return { kind: "denied", reason: decision.reason };
			}
		}

		// Approval gate — only when an ApprovalManager is wired. The TUI's
		// approvalMode (read-only / auto-edit / full-auto) lives inside this
		// manager and decides whether the call needs a user confirmation.
		if (this.approvalManager) {
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
			await snapshots.snapshot(targetPath, this.projectRoot);
		}

		// Execute the tool itself.
		let executed: { content: string; isError: boolean };
		try {
			const result = await this.tools.execute(call, {
				...(signal !== undefined && { signal }),
				workingDirectory: this.projectRoot,
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
		// failed). Failure rolls back via SnapshotManager and folds the diag
		// into the tool_result content so the next assistant turn can react.
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
			);
			if (validation && !validation.passed) {
				const restored = await snapshots.restore(
					targetPath,
					this.projectRoot,
				);
				const issues = validation.checks.filter((c) => !c.passed);
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
		}

		return {
			kind: "executed",
			content: executed.content,
			isError: executed.isError,
		};
	}

	private async runValidator(
		toolName: string,
		args: Record<string, unknown>,
		result: { content: string; isError: boolean },
		filePath: string,
	): Promise<ValidationResult | undefined> {
		if (!this.validator) return undefined;
		try {
			return await this.validator.validate({
				toolName,
				toolArgs: args,
				toolResult: result,
				filePath,
				workingDirectory: this.projectRoot,
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
	| { kind: "executed"; content: string; isError: boolean };

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
