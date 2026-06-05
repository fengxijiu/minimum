import type { DagHarness, DagHarnessOptions } from "./DagHarness.js";
import type { HarnessEvent } from "./HarnessEvent.js";
import { TaskGraphIndex } from "./TaskGraphIndex.js";
import { ReadyQueue } from "./ReadyQueue.js";
import { ResultStore } from "./ResultStore.js";
import { ArtifactIndex } from "./ArtifactIndex.js";
import { RunningSet } from "./RunningSet.js";
import type { TaskContract } from "./TaskContract.js";
import type { TaskResult } from "./TaskRunner.js";
import { runTask } from "./TaskRunner.js";

/**
 * DynamicHarness — real-time DAG-driven sub-agent scheduler.
 *
 * Unlike WaveHarness (barrier-based waves), DynamicHarness unlocks
 * downstream tasks as soon as their upstream dependencies complete.
 * Tasks are queued via ReadyQueue, gated through write-lock and
 * concurrency checks, then executed via runTask.
 *
 * Defaults (from SUBAGENT_OPTIMISE.md):
 *   • global max active: 4
 *   • persona concurrency: code_executor ×2, test_runner ×1, repo_scout ×2
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

		// Global concurrency — default 4
		const maxGlobal = 4;
		const personaCaps: Record<string, number> = {
			code_executor: 2,
			test_writer: 1,
			test_runner: 2,
			repo_scout: 2,
			context_builder: 1,
			reviewer: 1,
			docs: 1,
			vision: 2,
			runtime_debug: 1,
		};

		emit?.({ type: "harness_start", taskCount: contracts.length });

		// Enqueue all root (zero-dependency) tasks
		const roots = graph.getRootTasks();
		for (const id of roots) {
			graph.setStatus(id, "ready");
			const contract = graph.getContract(id);
			if (contract) {
				queue.enqueue(contract);
				emit?.({ type: "task_ready", taskId: id });
			}
		}

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
			results.set(taskId, result);
			artifacts.ingest(taskId, result);

			if (result.status === "ok") {
				emit?.({ type: "task_done", result });
				const newlyReady = graph.tryUnlock(taskId);
				for (const id of newlyReady) {
					graph.setStatus(id, "ready");
					const c = graph.getContract(id);
					if (c) {
						queue.enqueue(c);
						emit?.({ type: "task_ready", taskId: id });
						emit?.({ type: "dependency_unlocked", taskId: id, unlockedBy: taskId });
					}
				}
			} else if (result.status === "blocked") {
				emit?.({ type: "task_blocked", result, reason: result.errors.join("; ") });
				graph.markDeferred(taskId);
			} else if (result.status === "error" || result.status === "contract_invalid") {
				const eventType = result.status === "contract_invalid" ? "task_blocked" : "task_failed";
				emit?.({ type: eventType as "task_failed", result, error: result.errors.join("; ") });
				const skipped = graph.propagateFailure(taskId);
				for (const sid of skipped) {
					emit?.({ type: "task_skipped", taskId: sid, reason: `upstream ${taskId} failed` });
				}
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
				if (!canLaunch(contract, running, personaCaps, maxGlobal)) {
					// Persona slot full — put back and try next task.
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
						graph.propagateFailure(taskId);
						handleTaskComplete(taskId, personaId, failResult);
					});
			}
			// Re-enqueue tasks that couldn't launch due to persona caps.
			for (const t of skippedTasks.reverse()) queue.enqueue(t);
			return launched;
		};

		// ── Main scheduling loop ──────────────────────────────────────────
		drainQueue();

		while (running.activeCount > 0 || !queue.isEmpty) {
			// Idle detection: nothing running and nothing queued, but DAG incomplete.
			if (running.activeCount === 0 && queue.isEmpty) {
				if (!graph.isComplete) {
					const diags = graph.buildIdleDiagnostics();
					emit?.({
						type: "queue_idle",
						pending: graph.pendingCount,
						blocked: graph.blockedCount,
						deferred: diags.filter(d => d.reason.includes("deferred")).length,
						diagnostics: diags,
					});
				}
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

		const allResults = results.getAll();
		emit?.({ type: "harness_complete", allResults });
		yield { type: "harness_complete", allResults };
	}

	async runToCompletion(
		contracts: TaskContract[],
		options?: DagHarnessOptions,
	): Promise<TaskResult[]> {
		// B3: Collect only from harness_complete to avoid duplicates.
		const results: TaskResult[] = [];
		for await (const event of this.run(contracts, options)) {
			if (event.type === "harness_complete") {
				results.push(...event.allResults);
			}
		}
		return results;
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function executeTask(
	contract: TaskContract,
	options?: DagHarnessOptions,
): Promise<TaskResult> {
	if (!options) throw new Error("DynamicHarness requires options with projectRoot and executor");
	return runTask(contract, {
		projectRoot: options.projectRoot,
		executor: options.executor,
		refreshScheduler: options.refreshScheduler,
	});
}

function canLaunch(
	contract: TaskContract,
	running: RunningSet,
	personaCaps: Record<string, number>,
	maxGlobal: number,
): boolean {
	if (running.activeCount >= maxGlobal) return false;
	const personaCap = personaCaps[contract.personaId] ?? 2;
	if (running.personaCount(contract.personaId) >= personaCap) return false;
	return true;
}
