import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentGitStore } from "./AgentGitStore.js";
import type { RunId, TaskId } from "./types.js";

interface SnapEntry {
  /** Blob sha in the git object store, or null when the file didn't exist. */
  blobSha: string | null;
}

/**
 * Drop-in replacement for `SnapshotManager`.
 *
 * Persists pre-edit file content as git blobs so rollbacks survive process
 * restarts. The external interface (snapshot / restore / reset) is
 * identical to the old in-memory manager so call-sites need no changes.
 */
export class GitSnapshotManager {
  private entries = new Map<string, SnapEntry>(); // key = absolute path

  constructor(
    private readonly store: AgentGitStore,
    // Reserved for Phase 2 (audit refs): will namespace snapshots under
    // refs/minimum/<runId>/<taskId> to enable crash-recovery reconstruction.
    // Not used in Phase 1's blob-only storage.
    private readonly runId: RunId,
    private readonly taskId: TaskId,
  ) {}

  private resolvePath(rawPath: string, workingDirectory?: string): string {
    return workingDirectory
      ? path.resolve(workingDirectory, rawPath)
      : path.resolve(rawPath);
  }

  /** Capture file state before an edit. No-op if already snapshotted. */
  async snapshot(rawPath: string, workingDirectory?: string): Promise<void> {
    const abs = this.resolvePath(rawPath, workingDirectory);
    if (this.entries.has(abs)) return;

    let content: string | null;
    try {
      content = await fs.readFile(abs, "utf-8");
    } catch {
      content = null; // file did not exist
    }

    if (content === null) {
      this.entries.set(abs, { blobSha: null });
      return;
    }

    // Store blob in git object store.
    const blobSha = await this.store.storeBlob(content);
    this.entries.set(abs, { blobSha });
  }

  /** Restore a file to its snapshotted state. Returns false if not snapshotted. */
  async restore(rawPath: string, workingDirectory?: string): Promise<boolean> {
    const abs = this.resolvePath(rawPath, workingDirectory);
    const entry = this.entries.get(abs);
    if (entry === undefined) return false;

    if (entry.blobSha === null) {
      // File did not exist before — delete it.
      await fs.unlink(abs).catch(() => {});
    } else {
      const content = await this.store.readBlob(entry.blobSha);
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
