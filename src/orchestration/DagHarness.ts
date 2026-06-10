import type { TaskContract } from "./TaskContract.js";
import type { HarnessEvent } from "./HarnessEvent.js";
import type { TaskRunnerOptions, TaskResult } from "./TaskRunner.js";

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
