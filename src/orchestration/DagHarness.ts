import type { TaskContract } from "./TaskContract.js";
import type { HarnessEvent } from "./HarnessEvent.js";
import type { TaskRunnerOptions, TaskResult } from "./TaskRunner.js";
import type { RoutePolicy } from "./RoutePolicy.js";

/**
 * DagHarness — unified scheduler interface for executing a set of TaskContracts.
 *
 * The current implementation is DynamicHarness, which unlocks downstream work
 * as soon as upstream dependencies complete.
 *
 * External code depends only on this interface, not on a concrete scheduler.
 */

export interface DagHarnessOptions extends TaskRunnerOptions {
	/** Called for every harness event (lifecycle, task transitions, etc.). */
	onEvent?: (event: HarnessEvent) => void;
	/** Optional route-level scheduling policy for persona concurrency caps. */
	routePolicy?: RoutePolicy;
	/** When true, each task runs in its own git worktree, so the scheduler skips
	 *  write-lock serialisation and lets overlapping-glob tasks run in parallel. */
	worktreeIsolation?: boolean;
	/** Global concurrency cap for in-flight worker tasks. Defaults to the
	 *  ResourceManager ceiling (50). The MiMoClient ApiConcurrencyGate remains the
	 *  true global API backstop. `signal` (inherited from TaskRunnerOptions) cancels
	 *  the whole DAG: running tasks abort and the remainder flush as skipped. */
	globalConcurrency?: number;
	/**
	 * Results from earlier phases (e.g. W1 perception) that this invocation's tasks
	 * may depend on via cross-phase launchRequirements. The harness evaluates the
	 * launch gate against these PLUS its own results, so cross-phase requirements
	 * are honoured rather than silently dropped (#7). When omitted, only this
	 * invocation's results are visible to the gate.
	 */
	priorResults?: TaskResult[];
}

export interface DagHarness {
	/**
	 * Execute a list of fully-resolved TaskContracts.
	 *
	 * Returns an async generator of HarnessEvents so the caller can stream
	 * progress to TUI / logs in real time. The final event is always
	 * `harness_complete` containing the aggregated results.
	 */
	run(contracts: TaskContract[], options?: DagHarnessOptions): AsyncGenerator<HarnessEvent>;

	/**
	 * Convenience: collect all results into a single array.
	 * Defaults to calling run() and filtering harness_complete.
	 */
	runToCompletion(contracts: TaskContract[], options?: DagHarnessOptions): Promise<TaskResult[]>;
}

/** Shared default implementation of runToCompletion. */
export async function collectHarnessResults(
	harness: DagHarness,
	contracts: TaskContract[],
	options?: DagHarnessOptions,
): Promise<TaskResult[]> {
	const results: TaskResult[] = [];
	for await (const event of harness.run(contracts, options)) {
		if (event.type === "harness_complete") {
			results.push(...event.allResults);
		}
		// B3: Removed duplicate collection — harness_complete already aggregates all results.
	}
	return results;
}
