import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGitStore } from "../../src/git/AgentGitStore.js";
import { WorktreeIsolator } from "../../src/git/WorktreeIsolator.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-wti-test-"));
  execFileSync("git", ["init"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const slug = tmpDir.replace(/[/\\:]/g, "-").replace(/^-+/, "");
  fs.rmSync(path.join(os.homedir(), ".minimum", "shadow", slug), {
    recursive: true,
    force: true,
  });
});

async function makeBaseCommit(store: AgentGitStore): Promise<string> {
  return store.commitTree(
    [{ relativePath: "readme.txt", content: "base" }],
    "initial",
  );
}

describe("WorktreeIsolator.create", () => {
  it("returns a path that exists and contains the base commit files", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await makeBaseCommit(store);
    const isolator = new WorktreeIsolator(store);

    const wt = await isolator.create("task-1", baseSha);
    try {
      expect(fs.existsSync(wt)).toBe(true);
      expect(fs.existsSync(path.join(wt, "readme.txt"))).toBe(true);
    } finally {
      await isolator.discard("task-1");
    }
  });

  it("throws when create is called twice for the same taskId", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await makeBaseCommit(store);
    const isolator = new WorktreeIsolator(store);
    await isolator.create("task-dup", baseSha);
    try {
      await expect(
        isolator.create("task-dup", baseSha),
      ).rejects.toThrow('task "task-dup" already has a worktree');
    } finally {
      await isolator.discard("task-dup");
    }
  });
});

describe("WorktreeIsolator.commitAndApply", () => {
  it("returns { sha: null, changedFiles: [] } when no changes made", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await makeBaseCommit(store);
    const isolator = new WorktreeIsolator(store);

    await isolator.create("task-clean", baseSha);
    const result = await isolator.commitAndApply("task-clean", baseSha, "no-op");
    expect(result.sha).toBeNull();
    expect(result.changedFiles).toEqual([]);
    await isolator.discard("task-clean");
  });

  it("captures a new file and applies it to the main working tree", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await makeBaseCommit(store);
    const isolator = new WorktreeIsolator(store);

    const wt = await isolator.create("task-new", baseSha);
    // Simulate task writing a new file inside the worktree
    fs.writeFileSync(path.join(wt, "output.ts"), "export const v = 42;", "utf-8");

    const result = await isolator.commitAndApply("task-new", baseSha, "add output.ts");
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.changedFiles).toContain("output.ts");
    // The file must now exist in the main working tree (tmpDir)
    expect(fs.existsSync(path.join(tmpDir, "output.ts"))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "output.ts"), "utf-8")).toBe("export const v = 42;");
    await isolator.discard("task-new");
  });

  it("removes a deleted file from the main working tree", async () => {
    // Create readme.txt in the main tree so it can be deleted
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "base", "utf-8");

    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await makeBaseCommit(store);
    const isolator = new WorktreeIsolator(store);

    const wt = await isolator.create("task-del", baseSha);
    fs.unlinkSync(path.join(wt, "readme.txt"));

    const result = await isolator.commitAndApply("task-del", baseSha, "delete readme");
    expect(result.changedFiles).toContain("readme.txt");
    expect(fs.existsSync(path.join(tmpDir, "readme.txt"))).toBe(false);
    await isolator.discard("task-del");
  });

  it("throws when called for an unknown taskId", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await makeBaseCommit(store);
    const isolator = new WorktreeIsolator(store);
    await expect(
      isolator.commitAndApply("nonexistent", baseSha, "msg"),
    ).rejects.toThrow('no worktree registered for task "nonexistent"');
  });
});

describe("WorktreeIsolator.discard", () => {
  it("removes the worktree directory and git registration", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await makeBaseCommit(store);
    const isolator = new WorktreeIsolator(store);

    const wt = await isolator.create("task-discard", baseSha);
    expect(fs.existsSync(wt)).toBe(true);

    await isolator.discard("task-discard");
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("is a no-op for an unknown taskId", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    const isolator = new WorktreeIsolator(store);
    await expect(isolator.discard("nonexistent-task")).resolves.toBeUndefined();
  });
});
