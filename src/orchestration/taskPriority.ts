/**
 * taskPriority — the single canonical ordering for ready/unlockable tasks.
 *
 * Both ReadyQueue (queue order) and TaskGraphIndex (root / newly-ready order)
 * import this so there is one priority口径, not two divergent ones (#7).
 *
 * Order: priority field → fewer unresolved deps → higher downstream impact →
 * lexicographic taskId (deterministic tie-break).
 */

export interface PriorityMetrics {
	/** Hard upstream deps still unresolved (lower = closer to runnable). */
	unresolved: number;
	/** Number of downstream dependents (higher = more impactful). */
	downstream: number;
}

/** Lower weight = higher priority. Unknown/missing → P2. */
export function priorityWeight(priority?: string): number {
	switch (priority) {
		case "P0": return 0;
		case "P1": return 1;
		case "P2": return 2;
		case "P3": return 3;
		default: return 2;
	}
}

export interface PriorityComparable {
	taskId: string;
	priority?: string;
}

/**
 * Compare two tasks for scheduling order. `metrics`, when supplied, provides the
 * graph-derived tie-breakers (unresolved deps, downstream impact); without it the
 * comparison falls back to priority then taskId.
 */
export function compareTaskPriority(
	a: PriorityComparable,
	b: PriorityComparable,
	metrics?: (taskId: string) => PriorityMetrics,
): number {
	const pa = priorityWeight(a.priority);
	const pb = priorityWeight(b.priority);
	if (pa !== pb) return pa - pb;

	if (metrics) {
		const ma = metrics(a.taskId);
		const mb = metrics(b.taskId);
		if (ma.unresolved !== mb.unresolved) return ma.unresolved - mb.unresolved;
		if (ma.downstream !== mb.downstream) return mb.downstream - ma.downstream;
	}

	return a.taskId.localeCompare(b.taskId);
}
