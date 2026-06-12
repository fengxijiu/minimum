import type { PersonaId } from "../personas/Persona.js";
import type { TaskContract } from "./TaskContract.js";
import { compareTaskPriority, type PriorityMetrics } from "./taskPriority.js";

/**
 * Runtime status of a task in the Dynamic Ready Queue.
 */
export type TaskRuntimeStatus =
	| "pending"
	| "ready"
	| "scheduled"
	| "running"
	| "ok"
	| "degraded"
	| "blocked"
	| "failed"
	| "contract_invalid"
	| "skipped"
	| "deferred";

/**
 * TaskGraphIndex — in-memory runtime graph index for dynamic scheduling.
 *
 * Compiles all TaskContracts into:
 *   • upstream deps (who I depend on)
 *   • downstream dependents (who depends on me)
 *   • unresolved dependency count (how many upstream deps are still not ok)
 *   • runtime status per task
 *
 * Usage:
 *   const idx = new TaskGraphIndex(contracts);
 *   idx.getDownstream("T1");     // [T2, T3]
 *   idx.isReady("T2");           // true if all hard deps are ok
 *   idx.tryUnlock("T1", () => {  // called when T1 completes ok
 *     // returns newly-ready tasks
 *   });
 */
export class TaskGraphIndex {
	private contracts = new Map<string, TaskContract>();
	private upstream = new Map<string, Set<string>>();
	private downstream = new Map<string, Set<string>>();
	private unresolvedCount = new Map<string, number>();
	private status = new Map<string, TaskRuntimeStatus>();
	private blockedByHuman = new Set<string>();
	private blockedByDeferred = new Set<string>();

	constructor(contracts: TaskContract[]) {
		// Validate: detect cycles (simple DFS)
		this.detectCycles(contracts);

		for (const c of contracts) {
			this.contracts.set(c.taskId, c);
			this.upstream.set(c.taskId, new Set(c.dependsOn));
			this.downstream.set(c.taskId, new Set());
			this.unresolvedCount.set(c.taskId, 0);
		}

		// Build downstream links
		for (const c of contracts) {
			for (const dep of c.dependsOn) {
				const ds = this.downstream.get(dep);
				if (ds) ds.add(c.taskId);
			}
		}

		// Count unresolved hard deps
		for (const c of contracts) {
			let count = 0;
			for (const dep of c.dependsOn) {
				if (this.contracts.has(dep)) count++;
			}
			this.unresolvedCount.set(c.taskId, count);
		}

		// Initialize status: all tasks start as "pending"
		for (const c of contracts) {
			this.status.set(c.taskId, "pending");
		}
	}

	/** @returns all root tasks with zero dependencies. */
	getRootTasks(): string[] {
		const roots: string[] = [];
		for (const c of this.contracts.values()) {
			if ((this.unresolvedCount.get(c.taskId) ?? 0) === 0) {
				roots.push(c.taskId);
			}
		}
		return roots.sort((a, b) => this.comparePriority(a, b));
	}

	/** @returns whether all hard dependsOn tasks are "ok". */
	isReady(taskId: string): boolean {
		if (this.blockedByHuman.has(taskId)) return false;
		if (this.blockedByDeferred.has(taskId)) return false;
		return (this.unresolvedCount.get(taskId) ?? 0) === 0;
	}
	/**
   	* Mark a task as completed (ok or degraded) and decrement all downstream
   	* unresolved counts. Returns the set of tasks that just became ready.
   	* Pass "degraded" to preserve the graph status when the result is degraded
   	* rather than masking it as "ok".
	 */
  tryUnlock(taskId: string, finalStatus: "ok" | "degraded" = "ok"): string[] {
    this.status.set(taskId, finalStatus);
		const newlyReady: string[] = [];
		for (const child of this.downstream.get(taskId) ?? []) {
			const prev = this.unresolvedCount.get(child) ?? 0;
			const next = Math.max(0, prev - 1);
			this.unresolvedCount.set(child, next);
			if (next === 0 && this.status.get(child) === "pending") {
				newlyReady.push(child);
			}
		}
		return newlyReady.sort((a, b) => this.comparePriority(a, b));
	}

	/**
	 * Skip all hard dependents of a failed task.
	 * Returns the list of task ids that were skipped.
	 *
	 * B2 fix: only skip a downstream when ALL of its upstreams are terminal
	 * AND at least one is failed. If some upstreams are still pending/ok,
	 * mark as blocked instead (defer to W3.5 or human confirmation).
	 */
	propagateFailure(taskId: string): string[] {
		this.status.set(taskId, "failed");
		const skipped: string[] = [];
		const visit = new Set<string>();
		const queue = [...(this.downstream.get(taskId) ?? [])];

		const TERMINAL: Set<TaskRuntimeStatus> = new Set(["ok", "degraded", "failed", "skipped", "contract_invalid"]);

		while (queue.length > 0) {
			const id = queue.shift()!;
			if (visit.has(id)) continue;
			visit.add(id);

			const upstream = this.upstream.get(id);
			if (!upstream) continue;

			const hasHardDep = upstream.has(taskId);
			const status = this.status.get(id);
			// "blocked" is re-evaluatable, not terminal: a node parked as blocked
			// because some upstream was still pending must be reconsidered when that
			// upstream later fails — otherwise it latches in blocked forever (#2).
			const isPending = status === "pending" || status === "ready" || status === "blocked";

			if (hasHardDep && isPending) {
				// Check all upstreams: are they all in a terminal state?
				const allTerminal = [...upstream].every(dep => TERMINAL.has(this.status.get(dep) ?? "pending"));
				if (!allTerminal) {
					// Some upstreams are still pending/ok/running — don't skip, mark blocked.
					this.status.set(id, "blocked");
					continue;
				}

				// All upstreams are terminal. Are any failed?
				const anyFailed = [...upstream].some(dep => {
					const s = this.status.get(dep);
					return s === "failed" || s === "skipped" || s === "contract_invalid";
				});

				if (anyFailed) {
					// All upstreams are done and at least one failed → skip this task.
					this.status.set(id, "skipped");
					this.unresolvedCount.set(id, 0);
					skipped.push(id);
					// Propagate to downstream — they now see this task as terminal.
					const children = this.downstream.get(id);
					if (children) for (const c of children) queue.push(c);
				} else {
					// All upstreams are ok — should be ready already via tryUnlock,
					// but if we got here the deps must have been fulfilled. No-op.
				}
			}
		}
		return skipped;
	}

	/** @returns all task ids that depend on this task. */
	getDownstream(taskId: string): string[] {
		return [...(this.downstream.get(taskId) ?? [])];
	}

	/** @returns the set of upstream task ids. */
	getUpstream(taskId: string): Set<string> {
		return this.upstream.get(taskId) ?? new Set();
	}

	getContract(taskId: string): TaskContract | undefined {
		return this.contracts.get(taskId);
	}

	getStatus(taskId: string): TaskRuntimeStatus {
		return this.status.get(taskId) ?? "pending";
	}

	getUnresolvedCount(taskId: string): number {
		return this.unresolvedCount.get(taskId) ?? 0;
	}

	setStatus(taskId: string, s: TaskRuntimeStatus): void {
		this.status.set(taskId, s);
	}

	markHumanBlocked(taskId: string): void { this.blockedByHuman.add(taskId); }
	clearHumanBlocked(taskId: string): void { this.blockedByHuman.delete(taskId); }
	markDeferred(taskId: string): void {
		this.blockedByDeferred.add(taskId);
		this.status.set(taskId, "deferred");
	}
	clearDeferred(taskId: string): void {
		this.blockedByDeferred.delete(taskId);
		if (this.status.get(taskId) === "deferred") {
			this.status.set(taskId, "pending");
		}
	}
	/** @returns ids of every task currently held in the deferred set. */
	getDeferredIds(): string[] {
		return [...this.blockedByDeferred];
	}

	/** @returns count of tasks that are still pending / ready / scheduled / running. */
	get pendingCount(): number {
		let c = 0;
		for (const s of this.status.values()) {
			if (s === "pending" || s === "ready" || s === "scheduled" || s === "running") c++;
		}
		return c;
	}

	/** @returns count of tasks that are blocked or deferred. */
	get blockedCount(): number {
		let c = 0;
		for (const s of this.status.values()) {
			if (s === "blocked" || s === "deferred") c++;
		}
		return c;
	}

	/** @returns id of every task in the graph. */
	get allTaskIds(): string[] {
		return [...this.contracts.keys()];
	}

	/** @returns whether every task's status is a terminal state (ok/degraded/failed/skipped/contract_invalid). */
	get isComplete(): boolean {
		const terminal: Set<TaskRuntimeStatus> = new Set(["ok", "degraded", "failed", "skipped", "contract_invalid"]);
		for (const s of this.status.values()) {
			if (!terminal.has(s)) return false;
		}
		return true;
	}

	/**
	 * Build diagnostics for idle detection: for each pending/blocked/deferred
	 * task, list what it's waiting on.
	 */
	buildIdleDiagnostics(): Array<{ taskId: string; reason: string }> {
		const diags: Array<{ taskId: string; reason: string }> = [];
		for (const [taskId, s] of this.status) {
			if (s === "ok" || s === "degraded" || s === "failed" || s === "skipped" || s === "running") continue;
			if (s === "deferred") { diags.push({ taskId, reason: "waiting for repair or human confirmation" }); continue; }
			if (s === "blocked") { diags.push({ taskId, reason: "blocked by context gap or upstream failure" }); continue; }
			// pending/ready: list unresolved upstream deps. A degraded upstream has
			// already unlocked its downstream (F2), so it is resolved — not waiting (#8).
			const upstream = this.upstream.get(taskId) ?? new Set();
			const unresolved = [...upstream].filter(dep => {
				const s = this.status.get(dep);
				return s !== "ok" && s !== "degraded";
			});
			if (unresolved.length > 0) {
				const statuses = unresolved.map(d => `${d}(${this.status.get(d)})`).join(", ");
				diags.push({ taskId, reason: `waiting for upstream: ${statuses}` });
			} else {
				diags.push({ taskId, reason: "ready but waiting for resources or locks" });
			}
		}
		return diags;
	}

	/** Graph-derived priority metrics for {@link compareTaskPriority} (shared with ReadyQueue). */
	priorityMetrics(taskId: string): PriorityMetrics {
		return {
			unresolved: this.unresolvedCount.get(taskId) ?? 0,
			downstream: this.downstream.get(taskId)?.size ?? 0,
		};
	}

	// ── Private ────────────────────────────────────────────────────────────

	private comparePriority(a: string, b: string): number {
		return compareTaskPriority(
			{ taskId: a, priority: this.contracts.get(a)?.priority },
			{ taskId: b, priority: this.contracts.get(b)?.priority },
			(id) => this.priorityMetrics(id),
		);
	}

	private detectCycles(contracts: TaskContract[]): void {
		const byId = new Map(contracts.map(c => [c.taskId, c]));
		const visited = new Set<string>();
		const stack = new Set<string>();

		const dfs = (id: string): void => {
			if (stack.has(id)) {
				const cycle: string[] = [];
				for (const s of stack) { cycle.push(s); }
				cycle.push(id);
				throw new Error(`TaskGraphIndex: cycle detected: ${cycle.join(" → ")}`);
			}
			if (visited.has(id)) return;
			visited.add(id);
			stack.add(id);
			const c = byId.get(id);
			if (c) for (const dep of c.dependsOn) { if (byId.has(dep)) dfs(dep); }
			stack.delete(id);
		};

		for (const c of contracts) dfs(c.taskId);
	}
}
