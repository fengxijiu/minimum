import {
	findDanglingDeps,
	findGlobConflicts,
	findInterfaceContractIssues,
	validateContract,
} from "./ContractValidator.js";
import { groupBy } from "../utils/collections.js";
import type { CoarseDag, CoarseTask, TaskContract } from "./TaskContract.js";

/**
 * TaskGraph — toposort the DAG and slice it into scheduler batches.
 *
 * A batch is a set of tasks whose dependencies are already satisfied and whose
 * writable globs remain disjoint within each parallelGroup. Tasks with cyclic
 * dependencies cause `build()` to throw; the master must recompile.
 */

export interface TaskBatch {
	batchIndex: number;
	tasks: TaskContract[];
}

export interface BuildOptions {
	/** When true, run validateContract on every node before building. */
	validate: boolean;
}

export interface BuildResult {
	batches: TaskBatch[];
	/** Validation errors per task; empty if validate=false or all valid. */
	errors: Array<{ taskId: string; errors: string[] }>;
}

/**
 * Build scheduler batches from a fully-resolved contract list.
 * Throws on cycles. Returns validation errors as soft failures so the caller
 * can decide whether to abort or surface them as BLOCKED_INVALID_CONTRACT.
 */
export function buildTaskBatches(
	contracts: TaskContract[],
	opts: BuildOptions = { validate: true },
): BuildResult {
	const errors: BuildResult["errors"] = [];

	if (opts.validate) {
		for (const c of contracts) {
			const r = validateContract(c);
			if (!r.ok) errors.push({ taskId: c.taskId, errors: r.errors });
		}
		const conflicts = findGlobConflicts(contracts);
		if (conflicts.length > 0) {
			errors.push({
				taskId: "_glob_conflict",
				errors: conflicts.map(
					(c) => `${c.taskA} and ${c.taskB} both claim ${c.glob}`,
				),
			});
		}
		const dangling = findDanglingDeps(contracts);
		if (dangling.length > 0) {
			errors.push({
				taskId: "_dangling_dep",
				errors: dangling.map(
					(d) => `${d.taskId} depends on unknown task ${d.missingDep}`,
				),
			});
		}
		const interfaceIssues = findInterfaceContractIssues(contracts);
		if (interfaceIssues.length > 0) {
			errors.push({ taskId: "_interface_contract", errors: interfaceIssues });
		}
	}

	const byId = new Map<string, TaskContract>();
	for (const c of contracts) byId.set(c.taskId, c);

	// Kahn's algorithm, with stable ordering by taskId for determinism.
	const indegree = new Map<string, number>();
	const adjacency = new Map<string, string[]>();
	for (const c of contracts) {
		indegree.set(c.taskId, 0);
		adjacency.set(c.taskId, []);
	}
	for (const c of contracts) {
		for (const dep of c.dependsOn) {
			if (!byId.has(dep)) continue; // dangling dep — reported via findDanglingDeps
			adjacency.get(dep)!.push(c.taskId);
			indegree.set(c.taskId, (indegree.get(c.taskId) ?? 0) + 1);
		}
	}

	const batches: TaskBatch[] = [];
	let frontier = contracts
		.filter((c) => indegree.get(c.taskId) === 0)
		.map((c) => c.taskId)
		.sort();

	let scheduled = 0;
	let batchIndex = 0;
	while (frontier.length > 0) {
		const tasks = frontier.map((id) => byId.get(id)!);
		batches.push({ batchIndex, tasks });
		scheduled += tasks.length;
		batchIndex++;

		const next: string[] = [];
		for (const id of frontier) {
			for (const child of adjacency.get(id) ?? []) {
				const d = (indegree.get(child) ?? 0) - 1;
				indegree.set(child, d);
				if (d === 0) next.push(child);
			}
		}
		frontier = next.sort();
	}

	if (scheduled !== contracts.length) {
		const unscheduled = contracts
			.filter((c) => (indegree.get(c.taskId) ?? 0) > 0)
			.map((c) => c.taskId);
		throw new Error(
			`TaskGraph: cycle detected; unscheduled tasks: ${unscheduled.join(", ")}`,
		);
	}

	return { batches, errors };
}

/** Group tasks within a batch by parallelGroup — scheduler uses this to bound concurrency. */
export function partitionByParallelGroup(
	batch: TaskBatch,
): Map<string, TaskContract[]> {
	return groupBy(batch.tasks, (t) => t.parallelGroup);
}

/** Flatten a coarse DAG into a plain task list (master_planner output). */
export function flattenCoarse(dag: CoarseDag): CoarseTask[] {
	return dag.phases.flatMap((p) => p.tasks);
}
