import type { TaskResult } from "./TaskRunner.js";

/**
 * ResultStore — thread-safe store for task execution results.
 *
 * Used by DynamicHarness to:
 *   • Collect results from completed workers
 *   • Serve as evidence for ArtifactIndex and LaunchGate checks
 *   • Track written files per task for delivery
 *
 * Usage:
 *   const store = new ResultStore();
 *   store.set("T1", result);
 *   const r = store.get("T1");
 */
export class ResultStore {
	private results = new Map<string, TaskResult>();

	set(taskId: string, result: TaskResult): void {
		this.results.set(taskId, result);
	}

	get(taskId: string): TaskResult | undefined {
		return this.results.get(taskId);
	}

	has(taskId: string): boolean {
		return this.results.has(taskId);
	}

	/** @returns all stored results, sorted by taskId for determinism. */
	getAll(): TaskResult[] {
		return [...this.results.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
	}

	/** @returns only results with the given status. */
	filterByStatus(status: TaskResult["status"]): TaskResult[] {
		return this.getAll().filter(r => r.status === status);
	}

	/** @returns IDs of all stored tasks. */
	get keys(): string[] {
		return [...this.results.keys()];
	}

	get size(): number {
		return this.results.size;
	}
}
