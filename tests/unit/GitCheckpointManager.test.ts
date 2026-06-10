import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCheckpointManager } from "../../src/session/GitCheckpointManager.js";

let tmpDir: string;
let manager: GitCheckpointManager;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-gcp-"));
  execFileSync("git", ["init"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
  manager = new GitCheckpointManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const slug = tmpDir.replace(/[/\\:]/g, "-").replace(/^-+/, "");
  const shadowBase = path.join(os.homedir(), ".minimum", "shadow", slug);
  fs.rmSync(shadowBase, { recursive: true, force: true });
});

describe("GitCheckpointManager.createCheckpoint", () => {
  it("returns a Checkpoint with a 40-char SHA id", async () => {
    const msgs = [{ role: "user", content: "hello" }];
    const cp = await manager.createCheckpoint("session-1", msgs, { type: "test" });
    expect(cp.id).toMatch(/^[0-9a-f]{40}$/);
    expect(cp.sessionId).toBe("session-1");
    expect(cp.messages).toEqual(msgs);
    expect(cp.metadata).toEqual({ type: "test" });
    expect(cp.createdAt).toBeGreaterThan(0);
  });

  it("chains multiple checkpoints so each has a unique SHA", async () => {
    const cp1 = await manager.createCheckpoint("session-2", [
      { role: "user", content: "a" },
    ]);
    const cp2 = await manager.createCheckpoint("session-2", [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    expect(cp1.id).not.toBe(cp2.id);
    expect(cp2.id).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("GitCheckpointManager.restoreCheckpoint", () => {
  it("returns the original messages and metadata by SHA", async () => {
    const msgs = [
      { role: "user", content: "test msg" },
      { role: "assistant", content: "reply" },
    ];
    const cp = await manager.createCheckpoint("session-3", msgs, { tag: "v1" });

    const restored = await manager.restoreCheckpoint(cp.id);
    expect(restored).not.toBeNull();
    expect(restored!.messages).toEqual(msgs);
    expect(restored!.metadata).toEqual({ tag: "v1" });
    expect(restored!.sessionId).toBe("session-3");
    expect(restored!.id).toBe(cp.id);
  });

  it("returns null for an unknown SHA", async () => {
    const result = await manager.restoreCheckpoint("a".repeat(40));
    expect(result).toBeNull();
  });
});

describe("GitCheckpointManager.listCheckpoints", () => {
  it("lists checkpoints for a session in reverse-chronological order", async () => {
    await manager.createCheckpoint("session-4", [{ role: "user", content: "1" }]);
    await manager.createCheckpoint("session-4", [{ role: "user", content: "2" }]);
    await manager.createCheckpoint("session-4", [{ role: "user", content: "3" }]);

    const list = await manager.listCheckpoints("session-4");
    expect(list).toHaveLength(3);
    // Most recent first
    expect(list[0].messages[0].content).toBe("3");
    expect(list[2].messages[0].content).toBe("1");
  });

  it("returns empty array for a session with no checkpoints", async () => {
    expect(await manager.listCheckpoints("no-such-session")).toEqual([]);
  });

  it("lists checkpoints across all sessions when no sessionId given", async () => {
    await manager.createCheckpoint("session-5a", [
      { role: "user", content: "x" },
    ]);
    await manager.createCheckpoint("session-5b", [
      { role: "user", content: "y" },
    ]);

    const list = await manager.listCheckpoints();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const sessions = new Set(list.map((c) => c.sessionId));
    expect(sessions.has("session-5a")).toBe(true);
    expect(sessions.has("session-5b")).toBe(true);
  });
});
