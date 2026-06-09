import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentGitStore } from "./AgentGitStore.js";
import type { RunId, TaskId } from "./types.js";

interface SnapEntry {
  /**
   * Commit SHA under refs/minimum/<runId>/task/<taskId>, or null when
   * the file did not exist before the snapshot was taken.
   */
  commitSha: string | null;
  /** Path relative to the store work-tree (forward slashes). */
  relativePath: string;
}

/**
 * Drop-in replacement for `SnapshotManager`.
 *
 * Each `snapshot()` call creates a real git commit under
 * `refs/minimum/<runId>/task/<taskId>` so snapshots survive process restarts
 * and can be browsed with `RunAuditStore`. The external interface
 * (snapshot / restore / reset) is identical to the old in-memory manager.
 */
export class GitSnapshotManager {
  private entries = new Map<string, SnapEntry>(); // key = absolute path

  constructor(
    private readonly store: AgentGitStore,
    private readonly runId: RunId,
    private readonly taskId: TaskId,
  ) {}

  private resolvePath(rawPath: string, workingDirectory?: string): string {
    return workingDirectory
      ? path.resolve(workingDirectory, rawPath)
      : path.resolve(rawPath);
  }

  private get taskRef(): string {
    return `refs/minimum/${this.runId}/task/${this.taskId}`;
  }

  /** Capture file state before an edit. No-op if already snapshotted. */
  async snapshot(rawPath: string, workingDirectory?: string): Promise<void> {
    const abs = this.resolvePath(rawPath, workingDirectory);
    if (this.entries.has(abs)) return;

    // Compute path relative to the work-tree (forward slashes for git).
    const relativePath = path
      .relative(this.store.config.workTree, abs)
      .replace(/\\/g, "/");

    let content: string | null;
    try {
      content = await fs.readFile(abs, "utf-8");
    } catch {
      content = null; // file did not exist
    }

    if (content === null) {
      this.entries.set(abs, { commitSha: null, relativePath });
      return;
    }

    // Chain commits: read current tip as parent so the ref grows linearly.
    const parent = (await this.store.readRef(this.taskRef)) ?? undefined;
    const commitSha = await this.store.commitTree(
      [{ relativePath, content }],
      `snapshot: ${relativePath}`,
      {
        parent,
        trailers: {
          "Minimum-Run": this.runId,
          "Minimum-Task": this.taskId,
        },
      },
    );
    await this.store.setRef(this.taskRef, commitSha);
    this.entries.set(abs, { commitSha, relativePath });
  }

  /** Restore a file to its snapshotted state. Returns false if not snapshotted. */
  async restore(rawPath: string, workingDirectory?: string): Promise<boolean> {
    const abs = this.resolvePath(rawPath, workingDirectory);
    const entry = this.entries.get(abs);
    if (entry === undefined) return false;

    if (entry.commitSha === null) {
      // File did not exist before — delete it.
      await fs.unlink(abs).catch(() => {});
    } else {
      const content = await this.store.readFileAtCommit(
        entry.commitSha,
        entry.relativePath,
      );
      if (content === null) return false;
      await fs.writeFile(abs, content, "utf-8");
    }
    return true;
  }

  /** Clear all snapshots (called when a task scope ends cleanly). */
  reset(): void {
    this.entries.clear();
  }
}
