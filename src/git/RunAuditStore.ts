import type { AgentGitStore } from "./AgentGitStore.js";
import type { RunId } from "./types.js";

export interface CheckpointEntry {
  phase: string;
  sha: string;
}

export interface TaskRefEntry {
  taskId: string;
  sha: string;
}

/**
 * Manages checkpoint refs and provides browsing for agent run history.
 *
 * Checkpoints live at `refs/minimum/<runId>/checkpoint/<phase>`.
 * Task snapshots live at `refs/minimum/<runId>/task/<taskId>`.
 * Both are written into the same `AgentGitStore` (user repo or shadow repo).
 */
export class RunAuditStore {
  constructor(private readonly store: AgentGitStore) {}

  /**
   * Record a phase completion by creating an empty-tree commit with metadata
   * trailers and pointing `refs/minimum/<runId>/checkpoint/<phase>` at it.
   * Returns the new commit sha.
   */
  async setCheckpoint(runId: RunId, phase: string): Promise<string> {
    const ref = `refs/minimum/${runId}/checkpoint/${phase}`;
    const existing = (await this.store.readRef(ref)) ?? undefined;
    const sha = await this.store.commitTree([], `checkpoint: ${phase}`, {
      parent: existing,
      trailers: {
        "Minimum-Run": runId,
        "Minimum-Phase": phase,
      },
    });
    await this.store.setRef(ref, sha);
    return sha;
  }

  /** Return all distinct run IDs that have at least one checkpoint ref. */
  async listRuns(): Promise<RunId[]> {
    const refs = await this.store.forEachRef(
      "refs/minimum/*/checkpoint/*",
    );
    const ids = new Set<string>();
    for (const { ref } of refs) {
      // ref format: refs/minimum/<runId>/checkpoint/<phase>
      const m = ref.match(/^refs\/minimum\/([^/]+)\/checkpoint\//);
      if (m?.[1]) ids.add(m[1]);
    }
    return [...ids].sort();
  }

  /** Return all checkpoint entries for a given run, sorted by phase name. */
  async listCheckpoints(runId: RunId): Promise<CheckpointEntry[]> {
    const prefix = `refs/minimum/${runId}/checkpoint/`;
    const refs = await this.store.forEachRef(`${prefix}*`);
    return refs
      .map(({ ref, sha }) => ({ phase: ref.slice(prefix.length), sha }))
      .sort((a, b) => a.phase.localeCompare(b.phase));
  }

  /** Return all task snapshot refs for a given run. */
  async listTaskRefs(runId: RunId): Promise<TaskRefEntry[]> {
    const prefix = `refs/minimum/${runId}/task/`;
    const refs = await this.store.forEachRef(`${prefix}*`);
    return refs.map(({ ref, sha }) => ({
      taskId: ref.slice(prefix.length),
      sha,
    }));
  }
}
