import type { PersonaId } from "../personas/Persona.js";
import type { HarnessEvent } from "./HarnessEvent.js";
import { WriteLockManager } from "./WriteLockManager.js";

/**
 * ResourceManager — global resource scheduling for DynamicHarness.
 *
 * Controls:
 *   • Global concurrency cap (default 4)
 *   • Per-persona concurrency caps
 *   • Write locks via WriteLockManager
 *   • install_dependency global project lock
 *   • shell command limited concurrency (default 2)
 *
 * Usage:
 *   const rm = new ResourceManager();
 *   rm.configure({ globalMax: 4, code_executor: 2 });
 *   const ok = rm.acquire(contract);           // try to schedule
 *   rm.release(contract);                       // release after completion
 *   rm.getWaitReasons(contract);  // why a task can't launch yet
 */
export interface ResourceConfig {
	globalMax: number;
	personaCaps: Partial<Record<PersonaId, number>>;
	/** Max concurrent shell/install commands across all tasks. */
	shellMax: number;
	/**
	 * When true, skip WriteLockManager gating entirely.
	 * Use this when worktree isolation guarantees each task has its own
	 * filesystem tree and concurrent writes cannot corrupt each other.
	 */
	skipWriteLocks?: boolean;
}

const DEFAULT_CONFIG: ResourceConfig = {
	globalMax: 4,
	personaCaps: {
		code_executor: 2,
		test_writer: 1,
		test_runner: 2,
		repo_scout: 2,
		context_builder: 1,
		reviewer: 1,
		docs: 1,
		vision: 2,
		runtime_debug: 1,
	},
	shellMax: 2,
};

export class ResourceManager {
	private config: ResourceConfig;
	private writeLocks = new WriteLockManager();

	/** Per-persona active counts. */
	private personaActive = new Map<string, number>();

	/** Total active tasks. */
	private globalActive = 0;

	/** Active shell/install command count. */
	private shellActive = 0;

	/** Global install dependency lock — only one at a time. */
	private installLocked = false;

	constructor(config?: Partial<ResourceConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Try to acquire all resources for a task.
	 * Returns a list of reasons (HarnessEvent-style) if any resource is unavailable.
	 */
	acquire(
		taskId: string,
		personaId: string,
		allowedGlobs: string[],
		needsShell?: boolean,
		needsInstall?: boolean,
	):
		| { ok: true }
		| {
				ok: false;
				reasons: Array<{ type: string; detail: string }>;
				writeConflicts: Array<{ taskId: string; glob: string }>;
		  } {
		const reasons: Array<{ type: string; detail: string }> = [];

		// 1. Global concurrency
		if (this.globalActive >= this.config.globalMax) {
			reasons.push({ type: "global_concurrency", detail: `global limit reached (${this.globalActive}/${this.config.globalMax})` });
		}

		// 2. Persona concurrency
		const caps = this.config.personaCaps as Record<string, number | undefined>;
		const personaCap = caps[personaId] ?? 2;
		const personaActive = (this.personaActive.get(personaId) ?? 0);
		if (personaActive >= personaCap) {
			reasons.push({ type: "persona_concurrency", detail: `${personaId} limit reached (${personaActive}/${personaCap})` });
		}

		// 3. Write locks (skip when worktree isolation is active)
		let writeConflicts: Array<{ taskId: string; glob: string }> = [];
		if (!this.config.skipWriteLocks) {
			writeConflicts = this.writeLocks.tryLock(taskId, allowedGlobs);
			if (writeConflicts.length > 0) {
				reasons.push({
					type: "write_lock",
					detail: `blocked by ${writeConflicts.map(w => `${w.taskId} (${w.glob})`).join(", ")}`,
				});
			}
		}

		// 4. Install lock
		if (needsInstall && this.installLocked) {
			reasons.push({ type: "install_lock", detail: "dependency installation already in progress" });
		}

		// 5. Shell concurrency
		if (needsShell && this.shellActive >= this.config.shellMax) {
			reasons.push({ type: "shell_concurrency", detail: `shell limit reached (${this.shellActive}/${this.config.shellMax})` });
		}

		if (reasons.length > 0) {
			// Roll back write lock attempt if we actually acquired one
			if (!this.config.skipWriteLocks && writeConflicts.length === 0) {
				this.writeLocks.unlock(taskId);
			}
			return { ok: false, reasons, writeConflicts };
		}

		this.globalActive++;
		this.personaActive.set(personaId, personaActive + 1);
		if (needsInstall) this.installLocked = true;
		if (needsShell) this.shellActive++;
		return { ok: true };
	}

	/**
	 * Release all resources held by a task.
	 */
	release(taskId: string, personaId: string, needsShell?: boolean, needsInstall?: boolean): void {
		if (!this.config.skipWriteLocks) {
			this.writeLocks.unlock(taskId);
		}
		this.globalActive = Math.max(0, this.globalActive - 1);
		const count = this.personaActive.get(personaId) ?? 0;
		this.personaActive.set(personaId, Math.max(0, count - 1));
		if (needsInstall) this.installLocked = false;
		if (needsShell) this.shellActive = Math.max(0, this.shellActive - 1);
	}

	/** @returns harness events describing what's blocking this task. */
	getWaitEvents(taskId: string): HarnessEvent[] {
		const events: HarnessEvent[] = [];
		const writeConflicts = this.writeLocks.findConflicts([]);
		for (const w of writeConflicts) {
			events.push({ type: "write_lock_wait", taskId, blockedBy: [{ taskId: w.taskId, glob: w.glob }] });
		}
		return events;
	}

	get activeCount(): number { return this.globalActive; }

	writeLocksInfo(): { lockedCount: number; activeLocks: Array<{ taskId: string; globs: string[] }> } {
		return { lockedCount: this.writeLocks.lockedCount, activeLocks: this.writeLocks.activeLocks };
	}
}
