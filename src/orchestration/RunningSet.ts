import type { PersonaId } from "../personas/Persona.js";
import type { TaskContract } from "./TaskContract.js";

/**
 * Entry in the running set — tracks one currently-executing task.
 */
export interface RunningEntry {
	taskId: string;
	personaId: PersonaId;
	allowedGlobs: string[];
	startedAt: number;
	abortController: AbortController;
}

/**
 * RunningSet — tracks tasks currently executing.
 *
 * Used by DynamicHarness to:
 *   • Enforce concurrency limits (per-persona and global)
 *   • Detect write-glob conflicts before launching new tasks
 *   • Cancel tasks on user request
 *
 * Usage:
 *   const rs = new RunningSet();
 *   const entry = rs.add(contract);   // register as running
 *   rs.remove("T1");                   // mark as done
 *   rs.conflictsWith(contract);        // check write-lock conflicts
 */
export class RunningSet {
	private entries = new Map<string, RunningEntry>();

	add(entry: RunningEntry): void {
		this.entries.set(entry.taskId, entry);
	}

	remove(taskId: string): RunningEntry | undefined {
		const entry = this.entries.get(taskId);
		this.entries.delete(taskId);
		return entry;
	}

	get(taskId: string): RunningEntry | undefined {
		return this.entries.get(taskId);
	}

	has(taskId: string): boolean {
		return this.entries.has(taskId);
	}

	/** @returns how many tasks are currently running. */
	get activeCount(): number {
		return this.entries.size;
	}

	/** @returns how many tasks of a given persona are running. */
	personaCount(personaId: PersonaId): number {
		let count = 0;
		for (const e of this.entries.values()) {
			if (e.personaId === personaId) count++;
		}
		return count;
	}

	/** Cancel all running tasks. Returns list of cancelled task IDs. */
	cancelAll(): string[] {
		const ids: string[] = [];
		for (const e of this.entries.values()) {
			e.abortController.abort();
			ids.push(e.taskId);
		}
		this.entries.clear();
		return ids;
	}

	getAll(): RunningEntry[] {
		return [...this.entries.values()];
	}
}
