/**
 * WriteLockManager — conservative write-glob conflict detection.
 *
 * When two write-capable tasks have overlapping allowedGlobs, they
 * cannot run concurrently. This manager uses conservative matching:
 *   • Exact path match → conflict
 *   • Parent directory covers child → conflict (e.g. src/** vs src/api/upload.ts)
 *   • Sibling directories → no conflict (e.g. src/api/** vs src/components/**)
 *   • Unknown/ambiguous → conservative (treat as conflict)
 *
 * Usage:
 *   const mgr = new WriteLockManager();
 *   mgr.tryLock("T1", ["src/api/**"]);        // acquire lock
 *   mgr.isAvailable(["src/api/upload.ts"]);    // → false (locked by T1)
 *   mgr.unlock("T1");                          // release locks
 */
export class WriteLockManager {
	/** taskId → list of locked globs */
	private locks = new Map<string, string[]>();

	/** Try to acquire locks for a task. Returns array of conflicts or empty if locked. */
	tryLock(taskId: string, globs: string[]): Array<{ taskId: string; glob: string }> {
		const conflicts = this.findConflicts(globs);
		if (conflicts.length > 0) return conflicts;
		this.locks.set(taskId, globs);
		return [];
	}

	/** Release all locks held by a task. */
	unlock(taskId: string): void {
		this.locks.delete(taskId);
	}

	/** Check whether a set of globs can be locked (no conflicts with current locks). */
	isAvailable(globs: string[]): boolean {
		return this.findConflicts(globs).length === 0;
	}

	/** Check whether an existing task already holds conflicting locks. */
	findConflicts(globs: string[]): Array<{ taskId: string; glob: string }> {
		const conflicts: Array<{ taskId: string; glob: string }> = [];
		for (const [taskId, lockedGlobs] of this.locks) {
			for (const locked of lockedGlobs) {
				for (const candidate of globs) {
					if (globsOverlap(locked, candidate)) {
						conflicts.push({ taskId, glob: locked });
						break;
					}
				}
			}
		}
		return conflicts;
	}

	/** @returns all currently held locks. */
	get activeLocks(): Array<{ taskId: string; globs: string[] }> {
		return [...this.locks.entries()].map(([taskId, globs]) => ({ taskId, globs }));
	}

	get lockedCount(): number {
		return this.locks.size;
	}
}

// ── Glob overlap detection (no external deps) ──────────────────────────────

/**
 * Check if two glob patterns could target overlapping paths.
 *
 * Strategy (conservative — false positives preferred over false negatives):
 *   1. Exact string match → overlap
 *   2. One is a parent of the other (e.g. "src/**" covers "src/api/upload.ts")
 *   3. Both contain wildcards in overlapping directories → overlap
 *   4. Otherwise → no overlap
 */
export function globsOverlap(a: string, b: string): boolean {
	// Normalize backslashes to forward slashes
	const na = a.replace(/\\/g, "/");
	const nb = b.replace(/\\/g, "/");

	// Exact match
	if (na === nb) return true;

	// Strip trailing wildcards for parent-dir comparison
	const baseA = na.replace(/\/?\*\*?$/, "");
	const baseB = nb.replace(/\/?\*\*?$/, "");

	// Parent-dir coverage: if "src/api" starts with "src" → overlap
	const prefixA = noWildcardPrefix(na);
	const prefixB = noWildcardPrefix(nb);

	// If one prefix is a parent of the other → potential overlap
	if ((prefixA && prefixB) &&
		(prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA))) {
		return true;
	}

	// Parent coverage: explicit path falls under a wildcarded parent
	if (baseA.startsWith(baseB) || baseB.startsWith(baseA)) {
		return true;
	}

	// One is wildcard, other is explicit: check if the explicit path
	// falls under the wildcard directory
	if (na.includes("**") || na.includes("*")) {
		const staticPart = na.replace(/[*?]+/g, "").replace(/\/+/g, "/");
		if (staticPart && nb.startsWith(staticPart)) return true;
	}
	if (nb.includes("**") || nb.includes("*")) {
		const staticPart = nb.replace(/[*?]+/g, "").replace(/\/+/g, "/");
		if (staticPart && na.startsWith(staticPart)) return true;
	}

	return false;
}

/** Extract the path prefix before the first wildcard, or null. */
function noWildcardPrefix(glob: string): string | null {
	const idx = glob.search(/[*?[]/);
	if (idx === -1) return null;
	return glob.slice(0, idx).replace(/\/$/, "");
}
