import { AgentGitStore } from "../git/AgentGitStore.js";
import type { ChatMessage } from "../types/common.js";
import type { Checkpoint, ICheckpointManager } from "./types.js";

/**
 * Git-backed replacement for `CheckpointManager`.
 *
 * Each checkpoint is a commit under `refs/minimum/<sessionId>/session`.
 * The commit tree contains:
 *   - `checkpoint.json`  — `{ sessionId, metadata, createdAt, messageCount }`
 *   - `messages/0000.json` … `messages/NNNN.json` — one per message
 *
 * The `id` field of the returned `Checkpoint` is the commit SHA —
 * an opaque 40-character hex string compatible with the existing interface.
 */
export class GitCheckpointManager implements ICheckpointManager {
  private storePromise: Promise<AgentGitStore> | null = null;

  constructor(private readonly projectRoot: string) {}

  private getStore(): Promise<AgentGitStore> {
    if (!this.storePromise) {
      this.storePromise = AgentGitStore.resolve(this.projectRoot);
    }
    return this.storePromise;
  }

  private sessionRef(sessionId: string): string {
    return `refs/minimum/${sessionId}/session`;
  }

  async createCheckpoint(
    sessionId: string,
    messages: ChatMessage[],
    metadata: Record<string, unknown> = {},
  ): Promise<Checkpoint> {
    const store = await this.getStore();
    const ref = this.sessionRef(sessionId);
    const createdAt = Date.now();

    const files = [
      {
        relativePath: "checkpoint.json",
        content: JSON.stringify(
          { sessionId, metadata, createdAt, messageCount: messages.length },
          null,
          2,
        ),
      },
      ...messages.map((msg, i) => ({
        relativePath: `messages/${String(i).padStart(4, "0")}.json`,
        content: JSON.stringify(msg, null, 2),
      })),
    ];

    const parent = (await store.readRef(ref)) ?? undefined;
    const commitSha = await store.commitTree(
      files,
      `checkpoint: ${sessionId}`,
      {
        parent,
        trailers: { "Minimum-Session": sessionId },
      },
    );
    await store.setRef(ref, commitSha);

    return {
      id: commitSha,
      sessionId,
      messages: [...messages],
      metadata,
      createdAt,
    };
  }

  async restoreCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
    const store = await this.getStore();

    const metaRaw = await store.readFileAtCommit(
      checkpointId,
      "checkpoint.json",
    );
    if (!metaRaw) return null;

    let meta: {
      sessionId: string;
      metadata: Record<string, unknown>;
      createdAt: number;
      messageCount: number;
    };
    try {
      meta = JSON.parse(metaRaw);
    } catch {
      return null;
    }

    const messages: ChatMessage[] = [];
    for (let i = 0; i < meta.messageCount; i++) {
      const raw = await store.readFileAtCommit(
        checkpointId,
        `messages/${String(i).padStart(4, "0")}.json`,
      );
      if (raw === null) return null;
      try {
        messages.push(JSON.parse(raw) as ChatMessage);
      } catch {
        return null;
      }
    }

    return {
      id: checkpointId,
      sessionId: meta.sessionId,
      messages,
      metadata: meta.metadata,
      createdAt: meta.createdAt,
    };
  }

  async listCheckpoints(sessionId?: string): Promise<Checkpoint[]> {
    const store = await this.getStore();

    // Determine which session refs to walk.
    let refsToWalk: Array<{ sid: string }>;
    if (sessionId) {
      const tip = await store.readRef(this.sessionRef(sessionId));
      if (!tip) return [];
      refsToWalk = [{ sid: sessionId }];
    } else {
      const refs = await store.forEachRef("refs/minimum/*/session");
      refsToWalk = refs
        .map(({ ref }) => {
          const m = ref.match(/^refs\/minimum\/([^/]+)\/session$/);
          return m?.[1] ? { sid: m[1] } : null;
        })
        .filter((x): x is { sid: string } => x !== null);
    }

    const checkpoints: Checkpoint[] = [];
    for (const { sid } of refsToWalk) {
      const shas = await store.gitLog(this.sessionRef(sid));
      for (const sha of shas) {
        const cp = await this.restoreCheckpoint(sha);
        if (cp) checkpoints.push(cp);
      }
    }

    return checkpoints.sort((a, b) => b.createdAt - a.createdAt);
  }
}
