import type { PersonaId } from "../personas/Persona.js";
import type { TaskResult } from "./TaskRunner.js";
import type { TransactionEvent, TransactionSummary } from "../transaction/types.js";

/**
 * HarnessEvent — event stream emitted by {@link DynamicHarness}.
 *
 * Consumers (TUI, logs) should treat resource / queue-health events as optional.
 */

export type HarnessEvent =
	// ── Lifecycle ──────────────────────────────────────────────────────────
	| { type: "harness_start"; taskCount: number }
	| { type: "harness_complete"; allResults: TaskResult[] }

	// ── Task-level transitions ─────────────────────────────────────────────
	/** Task entered the ready queue. */
	| { type: "task_ready"; taskId: string }
	/** Task was scheduled onto a worker slot. */
	| { type: "task_scheduled"; taskId: string; personaId: PersonaId }
	/** Worker started executing the task. */
	| { type: "task_started"; taskId: string; personaId: PersonaId }
	/** Live progress snapshot from a running worker. */
	| {
			type: "task_progress";
			taskId: string;
			personaId: PersonaId;
			step: number;
			maxSteps: number;
			toolCalls: number;
			lastTool?: string;
			lastToolArgs?: string;
	  }
	/** Worker finished successfully. */
	| { type: "task_done"; result: TaskResult }
	/** Worker was blocked (context gap, missing artifact, etc.). */
	| {
			type: "task_blocked";
			result: TaskResult;
			reason?: string;
	  }
	/** Worker failed (execution or validation error). */
	| { type: "task_failed"; result: TaskResult; error?: string }
	/** Task was skipped because an upstream hard dependency failed. */
	| {
			type: "task_skipped";
			taskId: string;
			reason: string;
	  }

	// ── Resource / lock events (dynamic only) ──────────────────────────────
	| {
			type: "resource_wait";
			taskId: string;
			resource: string;
			/** How many tasks are queued for this resource. */
			queueDepth: number;
	  }
	| {
			type: "write_lock_wait";
			taskId: string;
			/** Which glob(s) are blocked by which running task(s). */
			blockedBy: Array<{ taskId: string; glob: string }>;
	  }
	| {
			type: "dependency_unlocked";
			taskId: string;
			/** Which upstream task just completed, unlocking this one. */
			unlockedBy: string;
	  }

	// ── Queue health ───────────────────────────────────────────────────────
	/** No tasks running and no tasks ready, but DAG is not complete (dynamic only). */
	| {
			type: "queue_idle";
			pending: number;
			blocked: number;
			deferred: number;
			/** Which dependency / resource / artifact each pending task is waiting on. */
			diagnostics: Array<{ taskId: string; reason: string }>;
	  }

	// ── Transaction lifecycle ──────────────────────────────────────────────
	| { type: "transaction_started"; taskId: string; transactionId: string }
	| { type: "transaction_completed"; taskId: string; summary: TransactionSummary }

	// ── Worker-internal events (forwarded from WorkerLoop) ─────────────────
	| {
			type: "worker_event";
			taskId: string;
			personaId: PersonaId;
			event: WorkerInternalEvent;
	  };

/** Events emitted from within a worker's execution loop. */
export type WorkerInternalEvent =
	| { type: "content"; delta: string }
	| { type: "reasoning"; delta: string }
	| { type: "tool_call"; toolName: string; args: string }
	| { type: "tool_result"; toolName: string; ok: boolean; content: string }
	| { type: "tool_denied"; toolName: string; reason: string }
	| { type: "tool_rolled_back"; toolName: string; path: string; restored: boolean; issues: number }
	| { type: "transaction_event"; event: TransactionEvent }
	| { type: "usage"; usage: {
			totalTokens: number;
			promptTokens: number;
			completionTokens: number;
			cachedTokens: number;
			totalCost: number;
			currency: "CNY" | "Credits";
			toolCalls: number;
			steps: number;
	  } };
