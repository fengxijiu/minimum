import { collectHarnessResults, type DagHarness, type DagHarnessOptions } from "./DagHarness.js";
import type { HarnessEvent } from "./HarnessEvent.js";
import { TaskGraphIndex } from "./TaskGraphIndex.js";
import { ReadyQueue } from "./ReadyQueue.js";
import { ResultStore } from "./ResultStore.js";
import { ArtifactIndex } from "./ArtifactIndex.js";
import { RunningSet } from "./RunningSet.js";
import { WriteLockManager } from "./WriteLockManager.js";
import { evaluateLaunchGate } from "./LaunchGate.js";
import type { TaskContract } from "./TaskContract.js";
import type { TaskResult } from "./TaskRunner.js";
import { runTaskWithRetry } from "./TaskRunner.js";
import { getPersona } from "../personas/PersonaRegistry.js";

/**
 * DynamicHarness — real-time DAG-driven sub-agent scheduler.
 *
 * Downstream tasks unlock as soon as their upstream dependencies complete
 * (rather than waiting on a whole-wave barrier). Tasks are queued via
 * ReadyQueue, gated through the launch gate, write-lock and concurrency
 * checks, then executed via runTask.
 *
 * Defaults (from SUBAGENT_OPTIMISE.md):
 *   • global max active: 99 (effectively unbounded — per-persona caps bind)
 *   • persona concurrency: 5 per category
 *   • idle detection: when running=0 and ready=0 and DAG incomplete → emit queue_idle
 *   • failure propagation: hard dep failed → downstream skipped
 *   • scheduling: priority + stable FIFO
 */
export class DynamicHarness implements DagHarness {
	async *run(
		contracts: TaskContract[],
		options?: DagHarnessOptions,
	): AsyncGenerator<HarnessEvent> {
		if (contracts.length === 0) {
			yield { type: "harness_complete", allResults: [] };
			return;
		}

		const emit = options?.onEvent;
		const graph = new TaskGraphIndex(contracts);
		const queue = new ReadyQueue();
		const results = new ResultStore();
		const artifacts = new ArtifactIndex();
		const running = new RunningSet();
		// Write-lock manager — serialises tasks whose allowedGlobs overlap so two
		// write-capable workers never touch the same files concurrently (§8).
		const writeLocks = new WriteLockManager();

		// Global concurrency — effectively unbounded; the per-persona caps below
		// are the binding constraint (each category may run up to 5 concurrently).
		// Per-persona caps are resolved at launch time from route policy first,
		// then PersonaRegistry defaults.
		const maxGlobal = 99;

		emit?.({ type: "harness_start", taskCount: contracts.length });

		/**
		 * F1 — Launch Gate. A task whose hard dependencies are satisfied may still
		 * be missing the structured artifacts its launchRequirements demand (e.g.
		 * an upstream in this DAG finished `ok` but never emitted `file_list`).
		 * Evaluate the launch gate before a task enters the ready queue.
		 *
		 * Only requirements whose sourceTaskId is part of THIS invocation are
		 * gated here — cross-phase requirements (e.g. a W2/3 task depending on a
		 * W1 perception artifact) are the caller's responsibility and were already
		 * gated by MiMoPipeline.applyLaunchGate with full cross-phase results.
		 */
		const promote = (id: string, unlockedBy?: string): void => {
			const contract = graph.getContract(id);
			if (!contract) return;
			const intraReqs = (contract.launchRequirements ?? []).filter(
				(r) => graph.getContract(r.sourceTaskId) !== undefined,
			);
			const gateContract =
				intraReqs.length === (contract.launchRequirements?.length ?? 0)
					? { ...contract, postStaticCompile: undefined }
					: { ...contract, launchRequirements: intraReqs, postStaticCompile: undefined };
			const decision = evaluateLaunchGate(gateContract, results.getAll(), artifacts.asMap());
			if (decision.ok) {
				graph.clearDeferred(id);
				graph.setStatus(id, "ready");
				queue.enqueue(contract);
				emit?.({ type: "task_ready", taskId: id });
				if (unlockedBy) emit?.({ type: "dependency_unlocked", taskId: id, unlockedBy });
			} else {
				// Required artifacts not (yet) available — hold the task as deferred so
				// idle detection / W3.5 can surface it rather than launching it blind.
				const wasDeferred = graph.getStatus(id) === "deferred";
				graph.markDeferred(id);
				if (!wasDeferred) {
					emit?.({ type: "resource_wait", taskId: id, resource: "launch_gate", queueDepth: 0 });
				}
			}
		};

		/** Re-run the launch gate on every deferred task — a just-finished upstream
		 *  may have produced the artifact a deferred task was waiting on. */
		const reevaluateDeferred = (): void => {
			for (const id of graph.getDeferredIds()) promote(id);
		};

		// Evaluate all root (zero-dependency) tasks through the launch gate.
		const roots = graph.getRootTasks();
		for (const id of roots) promote(id);

		// Notification mechanism: when a running task completes, its resolver
		// fires, waking the main scheduling loop so it can drain the queue.
		let wake: (() => void) | undefined;
		const nextNotification = (): Promise<void> =>
			new Promise<void>((r) => { wake = r; });

		/**
		 * Handle a task's completion result. Called from the .then() chain
		 * after every task finishes (ok / blocked / failed / error).
		 */
		const handleTaskComplete = (
			taskId: string,
			personaId: string,
			result: TaskResult,
		): void => {
			running.remove(taskId);
			writeLocks.unlock(taskId);
			results.set(taskId, result);
			artifacts.ingest(taskId, result);

			if (result.status === "ok") {
				emit?.({ type: "task_done", result });
				const newlyReady = graph.tryUnlock(taskId);
				for (const id of newlyReady) promote(id, taskId);
				reevaluateDeferred();
			} else if (result.status === "degraded") {
				// F2 — a degraded upstream (e.g. repo_scout fell back to read-only) is
				// NOT a failure: unlock downstream and let the launch gate decide whether
				// each one can proceed via canUseReadonlyFallback or must defer. This
				// matches wave-mode behaviour instead of blindly skipping the subtree.
				emit?.({ type: "task_done", result });
				const newlyReady = graph.tryUnlock(taskId);
				for (const id of newlyReady) promote(id, taskId);
				reevaluateDeferred();
			} else if (result.status === "skipped") {
				emit?.({ type: "task_skipped", taskId, reason: result.skipReason ?? result.errors.join("; ") });
				const skipped = graph.propagateFailure(taskId);
				for (const sid of skipped) {
					recordPropagatedSkip(sid, `upstream ${taskId} skipped`);
				}
			} else if (result.status === "blocked") {
				emit?.({ type: "task_blocked", result, reason: result.errors.join("; ") });
				graph.markDeferred(taskId);
			} else if (result.status === "error" || result.status === "contract_invalid") {
				const eventType = result.status === "contract_invalid" ? "task_blocked" : "task_failed";
				emit?.({ type: eventType as "task_failed", result, error: result.errors.join("; ") });
				const skipped = graph.propagateFailure(taskId);
				for (const sid of skipped) {
					recordPropagatedSkip(sid, `upstream ${taskId} failed`);
				}
			}

			function recordPropagatedSkip(skippedTaskId: string, reason: string): void {
				const skippedContract = graph.getContract(skippedTaskId);
				const skippedResult: TaskResult = {
					taskId: skippedTaskId,
					personaId: skippedContract?.personaId ?? "code_executor",
					status: "skipped",
					report: `<status>skipped</status>\n<summary>${reason}</summary>`,
					memoryCandidateBody: undefined,
					errors: [reason],
					skipReason: reason,
					durationMs: 0,
				};
				results.set(skippedTaskId, skippedResult);
				artifacts.ingest(skippedTaskId, skippedResult);
				emit?.({ type: "task_skipped", taskId: skippedTaskId, reason });
			}

			// Wake the main scheduling loop so it can launch newly-ready tasks.
			wake?.();
		};

		/**
		 * Launch as many queued tasks as concurrency allows.
		 * Safe to call at any time — no-op if queue is empty or concurrency
		 * is exhausted. Returns the count of newly-launched tasks.
		 */
		const drainQueue = (): number => {
			let launched = 0;
			const skippedTasks: TaskContract[] = [];
			while (!queue.isEmpty && running.activeCount < maxGlobal) {
				const contract = queue.dequeue();
				if (!contract) break;
				if (!canLaunch(contract, running, options, maxGlobal)) {
					// Persona slot full — put back and try next task.
					skippedTasks.push(contract);
					continue;
				}
				// Write-lock gate: refuse to launch a task whose allowedGlobs overlap
				// a currently-running task's. tryLock acquires the lock on success.
				const conflicts = writeLocks.tryLock(contract.taskId, contract.pathPolicy.allowedGlobs);
				if (conflicts.length > 0) {
					emit?.({ type: "write_lock_wait", taskId: contract.taskId, blockedBy: conflicts });
					skippedTasks.push(contract);
					continue;
				}
				launched++;
				graph.setStatus(contract.taskId, "scheduled");
				emit?.({ type: "task_scheduled", taskId: contract.taskId, personaId: contract.personaId });
				const ac = new AbortController();
				running.add({
					taskId: contract.taskId,
					personaId: contract.personaId,
					allowedGlobs: contract.pathPolicy.allowedGlobs,
					startedAt: Date.now(),
					abortController: ac,
				});
				graph.setStatus(contract.taskId, "running");
				emit?.({ type: "task_started", taskId: contract.taskId, personaId: contract.personaId });

				const taskId = contract.taskId;
				const personaId = contract.personaId;

				executeTask(contract, options)
					.then((result) => handleTaskComplete(taskId, personaId, result))
					.catch((err) => {
						const msg = err instanceof Error ? err.message : String(err);
						const failResult: TaskResult = {
							taskId,
							personaId,
							status: "error",
							report: "",
							memoryCandidateBody: undefined,
							errors: [msg],
							durationMs: 0,
						};
						emit?.({ type: "task_failed", result: failResult, error: msg });
						// Failure propagation + lock release are handled by handleTaskComplete
						// (its "error" branch calls propagateFailure); avoid a redundant pass.
						handleTaskComplete(taskId, personaId, failResult);
					});
			}
			// Re-enqueue tasks that couldn't launch due to persona caps or write-lock
			// conflicts. They are retried on the next drain (woken by a completion).
			for (const t of skippedTasks.reverse()) queue.enqueue(t);
			return launched;
		};

		// Idle detection: nothing running and nothing queued, but the DAG is not
		// complete (tasks stuck deferred/blocked). Emit once so TUI / W3.5 can act
		// instead of the harness exiting silently.
		let idleEmitted = false;
		const emitIdleIfIncomplete = (): void => {
			if (idleEmitted || graph.isComplete) return;
			idleEmitted = true;
			const diags = graph.buildIdleDiagnostics();
			emit?.({
				type: "queue_idle",
				pending: graph.pendingCount,
				blocked: graph.blockedCount,
				deferred: graph.getDeferredIds().length,
				diagnostics: diags,
			});
		};

		// ── Main scheduling loop ──────────────────────────────────────────
		drainQueue();

		while (running.activeCount > 0 || !queue.isEmpty) {
			if (options?.signal?.aborted) {
				running.cancelAll();
				break;
			}

			if (running.activeCount === 0 && queue.isEmpty) {
				emitIdleIfIncomplete();
				break;
			}

			// Try to fill concurrency slots.
			drainQueue();

			// If nothing more to do, stop.
			if (running.activeCount === 0 && queue.isEmpty) break;

			// Wait for at least one running task to finish before draining
			// again (avoids busy-wait on non-empty queue with full capacity).
			await nextNotification();
		}

		// The loop also exits when its condition (running || queued) goes false —
		// e.g. the last running task only unlocked deferred downstream. Cover that.
		emitIdleIfIncomplete();

		const allResults = results.getAll();
		emit?.({ type: "harness_complete", allResults });
		yield { type: "harness_complete", allResults };
	}

	runToCompletion(
		contracts: TaskContract[],
		options?: DagHarnessOptions,
	): Promise<TaskResult[]> {
		// Shared helper collects only from harness_complete to avoid duplicates (B3).
		return collectHarnessResults(this, contracts, options);
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function executeTask(
	contract: TaskContract,
	options?: DagHarnessOptions,
): Promise<TaskResult> {
	if (!options) throw new Error("DynamicHarness requires options with projectRoot and executor");
	return runTaskWithRetry(contract, {
		projectRoot: options.projectRoot,
		executor: options.executor,
		refreshScheduler: options.refreshScheduler,
		retryBackoff: options.retryBackoff,
	});
}

function canLaunch(
	contract: TaskContract,
	running: RunningSet,
	options: DagHarnessOptions | undefined,
	maxGlobal: number,
): boolean {
	if (running.activeCount >= maxGlobal) return false;
	const personaCap = personaCapFor(contract.personaId, options);
	if (running.personaCount(contract.personaId) >= personaCap) return false;
	return true;
}

function personaCapFor(personaId: string, options?: DagHarnessOptions): number {
	const routeCap = options?.routePolicy?.personaCaps[personaId as keyof typeof options.routePolicy.personaCaps];
	if (routeCap !== undefined) return routeCap;
	try {
		return getPersona(personaId as Parameters<typeof getPersona>[0]).parallelism.maxConcurrent;
	} catch {
		return 2;
	}
}
