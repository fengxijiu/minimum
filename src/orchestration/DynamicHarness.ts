import { collectHarnessResults, type DagHarness, type DagHarnessOptions } from "./DagHarness.js";
import type { HarnessEvent } from "./HarnessEvent.js";
import { TaskGraphIndex } from "./TaskGraphIndex.js";
import { ReadyQueue } from "./ReadyQueue.js";
import { ResultStore } from "./ResultStore.js";
import { ArtifactIndex } from "./ArtifactIndex.js";
import { RunningSet } from "./RunningSet.js";
import { ResourceManager } from "./ResourceManager.js";
import { buildArtifactMap, canUseReadonlyFallback, evaluateLaunchGate, isContextGapBlocked } from "./LaunchGate.js";
import type { TaskContract } from "./TaskContract.js";
import type { TaskResult } from "./TaskRunner.js";
import { runTaskWithRetry } from "./TaskRunner.js";
import { getPersona } from "../personas/PersonaRegistry.js";
import type { PersonaId } from "../personas/Persona.js";

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
		// Queue shares the graph's priority metrics so its ordering matches the
		// graph's root / newly-ready ordering — one canonical口径 (#7).
		const queue = new ReadyQueue((id) => graph.priorityMetrics(id));
		const results = new ResultStore();
		const artifacts = new ArtifactIndex();
		const running = new RunningSet();

		// Per-persona caps are resolved from route policy first, then
		// PersonaRegistry defaults.
		const personaCaps: Partial<Record<PersonaId, number>> = {};
		for (const c of contracts) {
			if (personaCaps[c.personaId] === undefined) {
				personaCaps[c.personaId] = personaCapFor(c.personaId, options);
			}
		}

		// Single resource authority for the scheduler: global + per-persona
		// concurrency, write-lock serialisation (overlapping allowedGlobs never run
		// concurrently, §8), and the install/shell locks. There is no second
		// capacity counter — every scheduling decision goes through ResourceManager.
		// Global cap defaults to the ResourceManager ceiling (50) unless the caller
		// overrides it; the MiMoClient ApiConcurrencyGate is the true global backstop.
		// Write locks are skipped when worktree isolation gives each task its own tree.
		const resources = new ResourceManager({
			...(options?.globalConcurrency !== undefined && { globalMax: options.globalConcurrency }),
			personaCaps,
			skipWriteLocks: options?.worktreeIsolation ?? false,
		});

		emit?.({ type: "harness_start", taskCount: contracts.length });

		// Cross-phase results (e.g. W1 perception) the launch gate must also see, so
		// requirements pointing outside this invocation are honoured, not dropped (#7).
		const priorResults = options?.priorResults ?? [];
		const priorArtifacts = buildArtifactMap(priorResults);
		const priorIds = new Set(priorResults.map((r) => r.taskId));

		// Per-task "one lenient (re)run" budget shared by the cross-phase launch-gate
		// gap path (promote) and the context-gap blocked path (handleTaskComplete) —
		// a task gets exactly one extra chance total before it is deferred (#7).
		const gateRetryUsed = new Set<string>();

		// Idle detection latch — a stuck queue emits exactly one queue_idle (carrying
		// diagnostics) before the harness flushes and completes (#10). Declared here
		// so the main loop and tail share it.
		let idleEmitted = false;

		/**
		 * F1 — Launch Gate. A task whose hard dependencies are satisfied may still
		 * be missing the structured artifacts its launchRequirements demand (e.g.
		 * an upstream finished `ok` but never emitted `file_list`). Evaluate the
		 * launch gate before a task enters the ready queue.
		 *
		 * The gate evaluates only requirements whose source is VISIBLE to this
		 * harness — a task in this invocation's graph/results, or one supplied via
		 * priorResults (e.g. W1 perception). Requirements whose source is entirely
		 * unknown here are left to the caller (which can make the harness the gate
		 * authority by injecting priorResults). This honours cross-phase requirements
		 * against real upstream data instead of silently dropping them (#7), without
		 * blocking on sources the harness was never told about. postStaticCompile is
		 * enforced at the tail, not here.
		 */
		const promote = (id: string, unlockedBy?: string): void => {
			const contract = graph.getContract(id);
			if (!contract) return;
			const allReqs = contract.launchRequirements ?? [];
			const gateableReqs = allReqs.filter(
				(r) => graph.getContract(r.sourceTaskId) !== undefined || priorIds.has(r.sourceTaskId) || results.has(r.sourceTaskId),
			);
			const gateContract =
				gateableReqs.length === allReqs.length
					? { ...contract, postStaticCompile: undefined }
					: { ...contract, launchRequirements: gateableReqs, postStaticCompile: undefined };
			const mergedResults = [...priorResults, ...results.getAll()];
			const mergedArtifacts = new Map([...priorArtifacts, ...artifacts.asMap()]);
			const decision = evaluateLaunchGate(gateContract, mergedResults, mergedArtifacts);
			if (decision.ok) {
				// Surface any requirement that only passed via a degraded upstream's
				// read-only fallback, so the caller can record it (replaces the wave
				// layer's readonlyFallbackIssues, #7).
				for (const r of gateableReqs) {
					const upstream = mergedResults.find((x) => x.taskId === r.sourceTaskId);
					if (!upstream) continue;
					if (mergedArtifacts.get(r.sourceTaskId)?.get(r.artifact)?.trim()) continue;
					if (canUseReadonlyFallback(r, upstream)) {
						emit?.({ type: "gate_fallback", taskId: id, reason: `${r.sourceTaskId}.${r.artifact} unavailable; proceeding via readonly fallback` });
					}
				}
				graph.clearDeferred(id);
				graph.setStatus(id, "ready");
				queue.enqueue(contract);
				emit?.({ type: "task_ready", taskId: id });
				if (unlockedBy) emit?.({ type: "dependency_unlocked", taskId: id, unlockedBy });
				return;
			}

			// Gate failed. A CROSS-PHASE gap (the unmet source lives only in
			// priorResults, not in this invocation's graph) gets ONE lenient run — the
			// worker may still succeed via read-only fallback — replacing the wave
			// layer's gate_retry (#7). static_compile gaps and INTRA gaps stay strict.
			const hasStaticCompileIssue = decision.issues.some(
				(i) => i.requirement.artifact === "static_compile_commands",
			);
			const allCrossPhase = decision.issues.length > 0 && decision.issues.every(
				(i) => priorIds.has(i.requirement.sourceTaskId) && graph.getContract(i.requirement.sourceTaskId) === undefined,
			);
			if (!hasStaticCompileIssue && allCrossPhase && !gateRetryUsed.has(id)) {
				gateRetryUsed.add(id);
				graph.clearDeferred(id);
				graph.setStatus(id, "ready");
				queue.enqueue(contract);
				emit?.({ type: "gate_retry", taskId: id, reason: decision.issues.map((i) => i.reason).join("; ") });
				if (unlockedBy) emit?.({ type: "dependency_unlocked", taskId: id, unlockedBy });
				return;
			}

			// Strict defer — hold as deferred so idle detection / W3.5 can surface it
			// rather than launching it blind. If the gate gap is terminal (budget used
			// or static compile), also announce task_deferred for the caller.
			const wasDeferred = graph.getStatus(id) === "deferred";
			graph.markDeferred(id);
			if (!wasDeferred) {
				emit?.({ type: "resource_wait", taskId: id, resource: "launch_gate", queueDepth: 0 });
				if (hasStaticCompileIssue || (allCrossPhase && gateRetryUsed.has(id))) {
					emit?.({
						type: "task_deferred",
						taskId: id,
						reason: decision.issues.map((i) => i.reason).join("; "),
						...(contract.blockedCondition && { blockedCondition: contract.blockedCondition }),
					});
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
			resources.release(taskId, personaId);
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
        		// Pass "degraded" so the graph status mirrors the result status rather
        		// than masking it as "ok".
				emit?.({ type: "task_done", result });
				const newlyReady = graph.tryUnlock(taskId, "degraded");
				for (const id of newlyReady) promote(id, taskId);
				reevaluateDeferred();
			} else if (result.status === "skipped") {
				emit?.({ type: "task_skipped", taskId, reason: result.skipReason ?? result.errors.join("; ") });
				const skipped = graph.propagateFailure(taskId);
				for (const sid of skipped) {
					recordPropagatedSkip(sid, `upstream ${taskId} skipped`);
				}
			} else if (result.status === "blocked") {
				// A context-gap block gets one re-run (the retryBlockedContextGaps role),
				// sharing the single per-task budget with the launch-gate leniency (#7).
				const contract = graph.getContract(taskId);
				if (contract && isContextGapBlocked(result) && !gateRetryUsed.has(taskId)) {
					gateRetryUsed.add(taskId);
					emit?.({ type: "gate_retry", taskId, reason: "context gap; granting one re-run" });
					graph.setStatus(taskId, "ready");
					queue.enqueue(contract);
				} else {
					emit?.({ type: "task_blocked", result, reason: result.errors.join("; ") });
					graph.markDeferred(taskId);
					emit?.({
						type: "task_deferred",
						taskId,
						reason: result.errors.join("; ") || "context gap unresolved",
						...(contract?.blockedCondition && { blockedCondition: contract.blockedCondition }),
					});
				}
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
		 * #1 — Flush every task that never produced a terminal result into `results`
		 * as a terminal `skipped`, so the harness output always covers the full
		 * contract set instead of silently dropping deferred/blocked/stuck tasks.
		 * Returns the ids that were flushed.
		 */
		const flushIncompleteTasks = (reasonFor: (id: string) => string): string[] => {
			const flushed: string[] = [];
			for (const id of graph.allTaskIds) {
				if (results.has(id)) continue;
				const contract = graph.getContract(id);
				const reason = reasonFor(id);
				const result: TaskResult = {
					taskId: id,
					personaId: contract?.personaId ?? "code_executor",
					status: "skipped",
					report: `<status>skipped</status>\n<summary>${reason}</summary>`,
					memoryCandidateBody: undefined,
					errors: [reason],
					skipReason: reason,
					durationMs: 0,
				};
				graph.setStatus(id, "skipped");
				results.set(id, result);
				artifacts.ingest(id, result);
				emit?.({ type: "task_skipped", taskId: id, reason });
				flushed.push(id);
			}
			return flushed;
		};

		/**
		 * Launch as many queued tasks as concurrency allows.
		 * Safe to call at any time — no-op if queue is empty or concurrency
		 * is exhausted. Returns the count of newly-launched tasks.
		 */
		const drainQueue = (): number => {
			let launched = 0;
			const skippedTasks: TaskContract[] = [];
			// Capacity is gated entirely by ResourceManager.acquire() — there is no
			// second active-count check here. We dequeue every ready task once;
			// whatever acquire() rejects (global cap, persona cap, write lock) is
			// re-enqueued for the next completion-driven drain.
			while (!queue.isEmpty) {
				const contract = queue.dequeue();
				if (!contract) break;
				// Single gate: global + per-persona concurrency AND write-lock
				// serialisation. acquire() commits the counters and write lock on
				// success; on failure it rolls back and reports why.
				const decision = resources.acquire(
					contract.taskId,
					contract.personaId,
					contract.pathPolicy.allowedGlobs,
				);
				if (!decision.ok) {
					// Surface write-lock contention for observability; concurrency-cap
					// waits just re-queue and retry on the next completion-driven drain.
					if (decision.writeConflicts.length > 0) {
						emit?.({ type: "write_lock_wait", taskId: contract.taskId, blockedBy: decision.writeConflicts });
					}
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
				const allowedGlobs = contract.pathPolicy.allowedGlobs;

				executeTask(contract, options, {
					// #6 — give up the write lock during backoff (keeping the concurrency
					// slot) and wake the loop so an overlapping task can run in the gap.
					beforeRetryWait: () => {
						resources.releaseWriteLock(taskId);
						wake?.();
					},
					// Re-acquire before the next attempt; spin until the gap holder
					// releases. No-op/instant under worktree isolation.
					afterRetryWait: async () => {
						while (!resources.tryReacquireWriteLock(taskId, allowedGlobs)) {
							await new Promise((r) => setTimeout(r, 1));
						}
					},
				})
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
		// complete (tasks stuck deferred/blocked). Emit so TUI / W3.5 can act
		// instead of the harness exiting silently.
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

		// #9 — whole-DAG cancellation. Abort every running task and stop scheduling;
		// the tail flush turns the remainder into terminal skipped("aborted").
		const signal = options?.signal;
		let aborted = signal?.aborted ?? false;
		const onAbort = (): void => { aborted = true; running.cancelAll(); wake?.(); };
		if (signal && !aborted) signal.addEventListener("abort", onAbort, { once: true });

		// ── Main scheduling loop ──────────────────────────────────────────
		drainQueue();

		while (!aborted && (running.activeCount > 0 || !queue.isEmpty)) {
			// Try to fill concurrency slots.
			drainQueue();

			if (running.activeCount === 0) {
				// Nothing in flight. Either the DAG is genuinely drained, or every
				// queued task is unschedulable (caps/locks with nothing to release
				// them) — #3. Either way no wake is coming, so stop instead of
				// awaiting a notification forever.
				emitIdleIfIncomplete();
				break;
			}

			// Wait for at least one running task to finish before draining again
			// (avoids busy-wait on a non-empty queue at full capacity).
			await nextNotification();
		}

		if (signal) signal.removeEventListener("abort", onAbort);

		// The loop also exits when its condition goes false — e.g. the last running
		// task only unlocked deferred downstream. Cover that, then flush (#1).
		emitIdleIfIncomplete();
		flushIncompleteTasks((id) => (aborted ? "aborted" : describeStall(graph, id)));

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

/** One-line reason why a never-run task is being flushed as skipped (#1). */
function describeStall(graph: TaskGraphIndex, id: string): string {
	const status = graph.getStatus(id);
	if (status === "deferred") return "deferred: launch requirements never satisfied";
	if (status === "blocked") return "blocked: upstream failure or unmet context gap";
	return `not scheduled before the queue drained (status: ${status})`;
}

interface RetryWaitCoordination {
	beforeRetryWait: () => void;
	afterRetryWait: () => Promise<void>;
}

async function executeTask(
	contract: TaskContract,
	options?: DagHarnessOptions,
	coord?: RetryWaitCoordination,
): Promise<TaskResult> {
	if (!options) throw new Error("DynamicHarness requires options with projectRoot and executor");
	const runId = options.runId ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
	return runTaskWithRetry(contract, {
		projectRoot: options.projectRoot,
		executor: options.executor,
		refreshScheduler: options.refreshScheduler,
		retryBackoff: options.retryBackoff,
		runId,
		...(options.signal && { signal: options.signal }),
		...(coord && { beforeRetryWait: coord.beforeRetryWait, afterRetryWait: coord.afterRetryWait }),
	});
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
