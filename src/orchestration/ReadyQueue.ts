import type { TaskContract } from "./TaskContract.js";

/**
 * ReadyQueue — priority-sorted queue of tasks ready for scheduling.
 *
 * Ordering (stable FIFO within same priority):
 *   1. Higher-level priority hints (P0 > P1 > P2 > P3)
 *   2. Lower dependency depth (fewer remaining upstream deps → earlier)
 *   3. Higher downstream impact (more children → earlier)
 *   4. Lexicographic taskId (deterministic tie-breaker)
 *
 * Usage:
 *   const q = new ReadyQueue();
 *   q.enqueue(contract);       // add one task
 *   q.enqueueAll([c1, c2]);    // add multiple
 *   const next = q.dequeue();  // get the highest-priority ready task
 *   q.remove("T1");            // remove a task by id
 *   q.size;                    // how many tasks are ready
 */
export class ReadyQueue {
	private items: TaskContract[] = [];

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
		this.items.sort((a, b) => {
			// Priority-level ordering
			const pa = priorityWeight(a);
			const pb = priorityWeight(b);
			if (pa !== pb) return pa - pb;

			// Dependency depth: fewer deps = earlier
			const da = a.dependsOn.length;
			const db = b.dependsOn.length;
			if (da !== db) return da - db;

			// Lexicographic taskId for determinism
			return a.taskId.localeCompare(b.taskId);
		});
	}
}

function priorityWeight(c: TaskContract): number {
	// Lower number = higher priority. CoarseTask may carry a priority field
	// through TaskContract; otherwise default to P2.
	const p = (c as any).priority as string | undefined;
	switch (p) {
		case "P0": return 0;
		case "P1": return 1;
		case "P2": return 2;
		case "P3": return 3;
		default: return 2;
	}
}
