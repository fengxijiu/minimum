import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentGitStore } from "./AgentGitStore.js";

export interface WorktreeResult {
  /** The commit SHA capturing the task's changes, or null if no changes. */
  sha: string | null;
  /** Relative paths of files that were written or deleted. */
  changedFiles: string[];
  /** Conflicting files left unapplied for the master to merge at W4. */
  conflicts: Array<{ path: string; baseSha: string; taskCommitSha: string }>;
}

/**
 * WorktreeIsolator — per-task git worktree lifecycle manager.
 *
 * Each task gets an isolated copy of the working tree via `git worktree add`.
 * After task completion, changes are committed and applied back to the main tree.
 *
 * Usage:
 *   const iso = new WorktreeIsolator(store);
 *   const wt = await iso.create(taskId, baseSha);
 *   // ... task writes files to wt ...
 *   const result = await iso.commitAndApply(taskId, baseSha, "task: summary");
 *   await iso.discard(taskId);
 */
export class WorktreeIsolator {
  private entries = new Map<string, { worktreePath: string }>();

  constructor(private readonly store: AgentGitStore) {}

  /**
   * Create a new git worktree for `taskId` at a temp path, checked out at `baseSha`.
   * Returns the worktree path (the directory the task should use as its root).
   */
  async create(taskId: string, baseSha: string): Promise<string> {
    if (this.entries.has(taskId)) {
      throw new Error(`WorktreeIsolator: task "${taskId}" already has a worktree`);
    }
    const worktreePath = path.join(
      os.tmpdir(),
      `minimum-wt-${taskId.replace(/[^a-zA-Z0-9-]/g, "_")}-${Date.now()}`,
    );
    await this.store.addWorktree(worktreePath, baseSha);
    this.entries.set(taskId, { worktreePath });
    return worktreePath;
  }

  /**
   * Stage all changes in the task's worktree, commit them, and apply the
   * changed files back to the main working tree.
   *
   * Returns:
   *   - `sha`: the new commit SHA, or `null` if the task made no changes
   *   - `changedFiles`: list of relative paths that were written or deleted
   */
  async commitAndApply(
    taskId: string,
    baseSha: string,
    message: string,
  ): Promise<WorktreeResult> {
    const entry = this.entries.get(taskId);
    if (!entry) {
      throw new Error(`WorktreeIsolator: no worktree registered for task "${taskId}"`);
    }
    const sha = await this.store.captureWorktreeChanges(entry.worktreePath, message);
    if (sha === null) {
      return { sha: null, changedFiles: [], conflicts: [] };
    }
    const changed = await this.store.listChangedFiles(baseSha, sha);
    const { conflicts } = await this.store.applyCommitFilesChecked(
      sha,
      baseSha,
      this.store.config.workTree,
    );
    return {
      sha,
      changedFiles: changed.map((f) => f.path),
      conflicts: conflicts.map((p) => ({ path: p, baseSha, taskCommitSha: sha })),
    };
  }

  /**
   * Remove the worktree from git's registry and delete its directory.
   * Safe to call even if the task was never created or was already discarded.
   */
  async discard(taskId: string): Promise<void> {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    this.entries.delete(taskId);
    await this.store.removeWorktree(entry.worktreePath, /* force */ true);
    // Safety net: removeWorktree --force swallows errors; ensure directory is gone.
    await fs.rm(entry.worktreePath, { recursive: true, force: true }).catch(() => {});
  }
}
