import type { TaskContract } from "./TaskContract.js";
import { compareTaskPriority, type PriorityMetrics } from "./taskPriority.js";

/**
 * ReadyQueue — priority-sorted queue of tasks ready for scheduling.
 *
 * Ordering is the single canonical {@link compareTaskPriority}:
 *   1. priority field (P0 > P1 > P2 > P3)
 *   2. fewer unresolved upstream deps first
 *   3. higher downstream impact first
 *   4. lexicographic taskId (deterministic tie-breaker)
 *
 * Steps 2–3 only apply when a graph metrics provider is supplied; without one
 * the queue orders by priority then taskId.
 *
 * Usage:
 *   const q = new ReadyQueue(id => ({ unresolved, downstream }));
 *   q.enqueue(contract);       // add one task
 *   q.enqueueAll([c1, c2]);    // add multiple
 *   const next = q.dequeue();  // get the highest-priority ready task
 *   q.remove("T1");            // remove a task by id
 *   q.size;                    // how many tasks are ready
 */
export class ReadyQueue {
	private items: TaskContract[] = [];

	constructor(private readonly metrics?: (taskId: string) => PriorityMetrics) {}

	enqueue(contract: TaskContract): void {
		this.items.push(contract);
		this.sort();
	}

	enqueueAll(contracts: TaskContract[]): void {
		this.items.push(...contracts);
		this.sort();
	}

	/** Remove and return the highest-priority task, or undefined if empty. */
	dequeue(): TaskContract | undefined {
		return this.items.shift();
	}

	/** Return the highest-priority task without removing it. */
	peek(): TaskContract | undefined {
		return this.items[0];
	}

	/** Remove a task by id. Returns true if found and removed. */
	remove(taskId: string): boolean {
		const idx = this.items.findIndex(c => c.taskId === taskId);
		if (idx === -1) return false;
		this.items.splice(idx, 1);
		return true;
	}

	/** Clear the queue. */
	clear(): void {
		this.items = [];
	}

	get size(): number {
		return this.items.length;
	}

	get isEmpty(): boolean {
		return this.items.length === 0;
	}

	/** Return all task ids currently in the queue (for diagnostics). */
	getTaskIds(): string[] {
		return this.items.map(c => c.taskId);
	}

	// ── Private ────────────────────────────────────────────────────────────

	private sort(): void {
		this.items.sort((a, b) => compareTaskPriority(a, b, this.metrics));
	}
}
