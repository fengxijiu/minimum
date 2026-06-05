import { buildWaves } from "./TaskGraph.js";
import { schedule, type WaveEvent } from "./WaveScheduler.js";
import type { DagHarness, DagHarnessOptions } from "./DagHarness.js";
import type { HarnessEvent } from "./HarnessEvent.js";
import type { TaskContract } from "./TaskContract.js";
import type { TaskResult } from "./TaskRunner.js";

/**
 * WaveHarness — barrier-based wave scheduler, wrapped as a DagHarness.
 *
 * This preserves the exact same scheduling behaviour as the original
 * buildWaves + schedule call chain, but exposes it through the DagHarness
 * interface so MiMoPipeline is decoupled from the concrete scheduler.
 *
 * `validateContracts` (default true) controls whether buildWaves runs
 * ContractValidator on every node. Set to false when contracts have
 * already been validated during refine (as MiMoPipeline does).
 */
export class WaveHarness implements DagHarness {
	private validateContracts: boolean;

	constructor(opts?: { validateContracts?: boolean }) {
		this.validateContracts = opts?.validateContracts ?? true;
	}

	async *run(
		contracts: TaskContract[],
		options?: DagHarnessOptions,
	): AsyncGenerator<HarnessEvent> {
		const emit = options?.onEvent;
		const { waves, errors } = buildWaves(contracts, { validate: this.validateContracts });
		const allResults: TaskResult[] = [];

		// Surface validation / structural errors as harness events.
		if (errors.length > 0) {
			for (const e of errors) {
				if (e.taskId === "_glob_conflict" || e.taskId === "_dangling_dep") {
					// Structural errors are surfaced individually.
					for (const msg of e.errors) {
						emit?.({ type: "task_blocked", result: {
							taskId: e.taskId,
							personaId: contracts[0]?.personaId ?? "master_planner",
							status: "blocked",
							report: "",
							memoryCandidateBody: undefined,
							errors: [msg],
							durationMs: 0,
						}, reason: msg });
					}
					continue;
				}
				emit?.({ type: "task_blocked", result: {
					taskId: e.taskId,
					personaId: contracts.find(c => c.taskId === e.taskId)?.personaId ?? "master_planner",
					status: "blocked",
					report: "",
					memoryCandidateBody: undefined,
					errors: e.errors,
					durationMs: 0,
				}, reason: e.errors.join("; ") });
			}
		}

		emit?.({ type: "harness_start", taskCount: contracts.length });

		const waveEventAdapter = (event: WaveEvent): void => {
			if (!emit) return;
			switch (event.type) {
				case "wave_start":
					emit({ type: "wave_start", waveIndex: event.waveIndex, taskCount: event.taskCount });
					break;
				case "task_start":
					// Find the contract to get personaId for the task_started event.
					{
						const contract = contracts.find(c => c.taskId === event.taskId);
						emit({ type: "task_started", taskId: event.taskId, personaId: contract?.personaId ?? "code_executor" });
					}
					break;
				case "task_done":
					emit({ type: "task_done", result: event.result });
					break;
				case "wave_complete":
					emit({ type: "wave_complete", waveIndex: event.waveIndex, results: event.results });
					break;
				case "stage_pause":
					// stage_pause is informational; mapped as resource_wait for TUI compatibility.
					emit({ type: "resource_wait", taskId: "_stage", resource: "stage_pause", queueDepth: 0 });
					break;
				case "schedule_complete":
					// Handled after schedule() returns.
					break;
			}
		};

		try {
			const results = await schedule(waves, {
				projectRoot: options?.projectRoot ?? process.cwd(),
				executor: options!.executor,
				onEvent: waveEventAdapter,
			});
			allResults.push(...results);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			emit?.({
				type: "task_failed",
				result: {
					taskId: "_schedule",
					personaId: "master_planner",
					status: "error",
					report: "",
					memoryCandidateBody: undefined,
					errors: [msg],
					durationMs: 0,
				},
				error: msg,
			});
		}

		emit?.({ type: "harness_complete", allResults });
		// Yield the final event so async-generator consumers see it.
		yield { type: "harness_complete", allResults };
	}

	async runToCompletion(
		contracts: TaskContract[],
		options?: DagHarnessOptions,
	): Promise<TaskResult[]> {
		const results: TaskResult[] = [];
		for await (const event of this.run(contracts, options)) {
			if (event.type === "harness_complete") {
				results.push(...event.allResults);
			}
		}
		return results;
	}
}
