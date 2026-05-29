import { getPersona } from "../personas/PersonaRegistry.js";
import type { TaskContract } from "./TaskContract.js";
import { runTask, type TaskResult, type TaskRunnerOptions } from "./TaskRunner.js";
import type { WaveSlot } from "./TaskGraph.js";

export type WaveEvent =
	| { type: "wave_start"; waveIndex: number; taskCount: number }
	| { type: "task_start"; waveIndex: number; taskId: string }
	| { type: "task_done"; waveIndex: number; result: TaskResult }
	| { type: "wave_complete"; waveIndex: number; results: TaskResult[] }
	| { type: "stage_pause"; waveIndex: number; reason: string }
	| { type: "schedule_complete"; allResults: TaskResult[] };

export interface ScheduleOptions extends TaskRunnerOptions {
	onEvent?: (event: WaveEvent) => void;
	/** Emit stage_pause before first wave when total tasks exceed this (default: 12). */
	largeDagThreshold?: number;
}

/**
 * WaveScheduler — execute a wave-sliced task DAG with per-persona concurrency limits.
 *
 * For each WaveSlot:
 *   1. Tasks whose persona has soloPerWave=true are deduplicated (first occurrence wins).
 *   2. Within the wave, tasks are grouped by personaId and run with each persona's
 *      maxConcurrent cap enforced via a semaphore.
 *   3. Groups from different personas run fully concurrently with each other.
 *
 * Emits lifecycle events so the TUI progress view can track state.
 */
export async function schedule(
	waves: WaveSlot[],
	opts: ScheduleOptions,
): Promise<TaskResult[]> {
	const emit = opts.onEvent ?? (() => {});
	const threshold = opts.largeDagThreshold ?? 12;
	const allResults: TaskResult[] = [];

	const totalTasks = waves.reduce((s, w) => s + w.tasks.length, 0);
	if (totalTasks > threshold) {
		emit({
			type: "stage_pause",
			waveIndex: 0,
			reason: `large DAG (${totalTasks} tasks exceeds threshold ${threshold})`,
		});
	}

	for (const wave of waves) {
		emit({ type: "wave_start", waveIndex: wave.waveIndex, taskCount: wave.tasks.length });

		const waveResults = await executeWave(wave.tasks, wave.waveIndex, opts, emit);
		allResults.push(...waveResults);

		emit({ type: "wave_complete", waveIndex: wave.waveIndex, results: waveResults });
	}

	emit({ type: "schedule_complete", allResults });
	return allResults;
}

async function executeWave(
	tasks: TaskContract[],
	waveIndex: number,
	opts: ScheduleOptions,
	emit: (e: WaveEvent) => void,
): Promise<TaskResult[]> {
	const selected = applyParallelismPolicy(tasks);

	// Group by persona so we can apply per-persona concurrency caps independently.
	const byPersona = new Map<string, TaskContract[]>();
	for (const t of selected) {
		const list = byPersona.get(t.personaId) ?? [];
		list.push(t);
		byPersona.set(t.personaId, list);
	}

	// Run all persona groups concurrently; within each group obey maxConcurrent.
	const groupPromises: Promise<TaskResult[]>[] = [];
	for (const [personaId, personaTasks] of byPersona) {
		const cap = safeMaxConcurrent(personaId);
		groupPromises.push(runGroupWithCap(personaTasks, cap, waveIndex, opts, emit));
	}

	const grouped = await Promise.all(groupPromises);
	return grouped.flat();
}

/** Dedup soloPerWave personas — keep only the first task per such persona. */
function applyParallelismPolicy(tasks: TaskContract[]): TaskContract[] {
	const seenSolo = new Set<string>();
	return tasks.filter((t) => {
		const persona = getPersona(t.personaId);
		if (!persona.parallelism.soloPerWave) return true;
		if (seenSolo.has(t.personaId)) return false;
		seenSolo.add(t.personaId);
		return true;
	});
}

function safeMaxConcurrent(personaId: string): number {
	try {
		return getPersona(personaId as Parameters<typeof getPersona>[0]).parallelism.maxConcurrent;
	} catch {
		return 1;
	}
}

/**
 * Run a list of tasks with a semaphore capped at `cap` concurrent executions.
 * Returns one promise per task so the caller can flatten them.
 */
async function runGroupWithCap(
	tasks: TaskContract[],
	cap: number,
	waveIndex: number,
	opts: ScheduleOptions,
	emit: (e: WaveEvent) => void,
): Promise<TaskResult[]> {
	let active = 0;
	const queue: Array<() => void> = [];

	const acquire = (): Promise<void> =>
		new Promise((resolve) => {
			if (active < cap) {
				active++;
				resolve();
			} else {
				queue.push(() => {
					active++;
					resolve();
				});
			}
		});

	const release = (): void => {
		active--;
		queue.shift()?.();
	};

	return Promise.all(
		tasks.map(async (contract) => {
			await acquire();
			emit({ type: "task_start", waveIndex, taskId: contract.taskId });
			try {
				const result = await runTask(contract, opts);
				emit({ type: "task_done", waveIndex, result });
				return result;
			} finally {
				release();
			}
		}),
	);
}
