import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGitStore } from "../../src/git/AgentGitStore.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const slug = tmpDir.replace(/[/\\:]/g, "-").replace(/^-+/, "");
  const shadowBase = path.join(os.homedir(), ".minimum", "shadow", slug);
  fs.rmSync(shadowBase, { recursive: true, force: true });
});

describe("AgentGitStore.resolve", () => {
  it("uses the user .git when inside a git repo", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);
    expect(store.config.gitDir).toBe(path.join(tmpDir, ".git"));
    expect(store.config.workTree).toBe(tmpDir);
  });

  it("creates a shadow repo when not inside a git repo", async () => {
    const store = await AgentGitStore.resolve(tmpDir);
    const slug = tmpDir.replace(/[/\\:]/g, "-").replace(/^-+/, "");
    const expected = path.join(os.homedir(), ".minimum", "shadow", slug, ".git");
    expect(store.config.gitDir).toBe(expected);
    expect(store.config.workTree).toBe(tmpDir);
    expect(fs.existsSync(store.config.gitDir)).toBe(true);
  });
});

describe("AgentGitStore.commitTree + setRef + readRef", () => {
  it("stores a file as a commit and recalls it via ref", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    // git needs at least a user identity to commit-tree
    execFileSync("git", ["config", "user.email", "test@minimum"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "minimum-test"], { cwd: tmpDir });

    const store = await AgentGitStore.resolve(tmpDir);

    const sha = await store.commitTree(
      [{ relativePath: "hello.txt", content: "world" }],
      "test commit",
    );
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const ref = "refs/minimum/run-test/task-1";
    await store.setRef(ref, sha);
    const read = await store.readRef(ref);
    expect(read).toBe(sha);

    // round-trip: read file content back from the commit
    const content = await store.readFileAtCommit(sha, "hello.txt");
    expect(content).toBe("world");

    // blob round-trip
    const blobSha = await store.storeBlob("blob content");
    expect(blobSha).toMatch(/^[0-9a-f]{40}$/);
    const blob = await store.readBlob(blobSha);
    expect(blob).toBe("blob content");
  });

  it("returns null for a missing ref", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);
    expect(await store.readRef("refs/minimum/does-not-exist")).toBeNull();
  });

  it("records a null-content file as a deletion marker", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);
    // Should not throw when content is null (file did not exist)
    const sha = await store.commitTree(
      [{ relativePath: "gone.txt", content: null }],
      "deletion snapshot",
    );
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("AgentGitStore.commitTree trailers + forEachRef", () => {
  it("embeds trailers in the commit message", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);

    const sha = await store.commitTree(
      [{ relativePath: "x.txt", content: "hi" }],
      "feat: test",
      { trailers: { "Minimum-Run": "run-1", "Minimum-Task": "task-1" } },
    );
    const msg: string = execFileSync(
      "git",
      ["log", "--format=%B", "-1", sha],
      { cwd: tmpDir },
    ).toString();
    expect(msg).toContain("feat: test\n\nMinimum-Run: run-1");
    expect(msg).toContain("Minimum-Task: task-1");
  });

  it("forEachRef lists refs matching a pattern", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);

    const sha = await store.commitTree(
      [{ relativePath: "y.txt", content: "yo" }],
      "test",
      {},
    );
    await store.setRef("refs/minimum/run-42/checkpoint/done", sha);

    const refs = await store.forEachRef("refs/minimum/**/checkpoint/*");
    expect(refs).toHaveLength(1);
    expect(refs[0].ref).toBe("refs/minimum/run-42/checkpoint/done");
    expect(refs[0].sha).toBe(sha);
  });

  it("forEachRef returns empty array when no refs match", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);
    const result = await store.forEachRef("refs/minimum/*/checkpoint/*");
    expect(result).toEqual([]);
  });
});

describe("AgentGitStore worktree primitives", () => {
  // We track worktree paths to clean them up even if tests fail
  const worktrees: string[] = [];

  afterEach(async () => {
    for (const wt of worktrees) {
      fs.rmSync(wt, { recursive: true, force: true });
    }
    worktrees.length = 0;
  });

  async function makeStoreWithCommit(): Promise<{
    store: AgentGitStore;
    baseSha: string;
  }> {
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);
    const baseSha = await store.commitTree(
      [{ relativePath: "seed.txt", content: "seed" }],
      "initial",
    );
    // We need a real branch/HEAD so that git worktree add works.
    // Set the ref so the main repo has a HEAD.
    await store.setRef("refs/heads/main", baseSha);
    // Also update HEAD to point to that branch:
    // Actually for git worktree add we just need the SHA, not HEAD.
    // But git requires the repo to have at least one commit reachable from HEAD
    // or we pass the SHA directly. Passing SHA + --detach works fine.
    return { store, baseSha };
  }

  it("addWorktree creates an isolated working tree checked out at baseSha", async () => {
    const { store, baseSha } = await makeStoreWithCommit();
    const wt = path.join(os.tmpdir(), `minimum-wt-test-${Date.now()}`);
    worktrees.push(wt);
    await store.addWorktree(wt, baseSha);
    expect(fs.existsSync(path.join(wt, "seed.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(wt, "seed.txt"), "utf-8")).toBe("seed");
    await store.removeWorktree(wt, true);
  });

  it("removeWorktree with force does not throw if worktree already gone", async () => {
    const { store, baseSha } = await makeStoreWithCommit();
    const wt = path.join(os.tmpdir(), `minimum-wt-rm-${Date.now()}`);
    worktrees.push(wt);
    await store.addWorktree(wt, baseSha);
    await store.removeWorktree(wt, true);
    // Second call should not throw
    await expect(store.removeWorktree(wt, true)).resolves.toBeUndefined();
  });

  it("captureWorktreeChanges returns null when worktree is clean", async () => {
    const { store, baseSha } = await makeStoreWithCommit();
    const wt = path.join(os.tmpdir(), `minimum-wt-clean-${Date.now()}`);
    worktrees.push(wt);
    await store.addWorktree(wt, baseSha);
    const sha = await store.captureWorktreeChanges(wt, "no-op");
    expect(sha).toBeNull();
    await store.removeWorktree(wt, true);
  });

  it("captureWorktreeChanges commits new files and returns a SHA", async () => {
    const { store, baseSha } = await makeStoreWithCommit();
    const wt = path.join(os.tmpdir(), `minimum-wt-cap-${Date.now()}`);
    worktrees.push(wt);
    await store.addWorktree(wt, baseSha);
    fs.writeFileSync(path.join(wt, "result.txt"), "task output", "utf-8");
    const sha = await store.captureWorktreeChanges(wt, "task: add result");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const content = await store.readFileAtCommit(sha!, "result.txt");
    expect(content).toBe("task output");
    await store.removeWorktree(wt, true);
  });

  it("listChangedFiles returns empty array for identical SHAs", async () => {
    const { store, baseSha } = await makeStoreWithCommit();
    const result = await store.listChangedFiles(baseSha, baseSha);
    expect(result).toEqual([]);
  });

  it("listChangedFiles detects added and deleted files", async () => {
    const { store, baseSha } = await makeStoreWithCommit();
    const wt = path.join(os.tmpdir(), `minimum-wt-diff-${Date.now()}`);
    worktrees.push(wt);
    await store.addWorktree(wt, baseSha);
    fs.writeFileSync(path.join(wt, "new.ts"), "export {};", "utf-8");
    fs.unlinkSync(path.join(wt, "seed.txt"));
    const toSha = await store.captureWorktreeChanges(wt, "mutate");
    const files = await store.listChangedFiles(baseSha, toSha!);
    const paths = files.map((f) => f.path);
    const deleted = files.filter((f) => f.deleted).map((f) => f.path);
    expect(paths).toContain("new.ts");
    expect(paths).toContain("seed.txt");
    expect(deleted).toContain("seed.txt");
    expect(deleted).not.toContain("new.ts");
    await store.removeWorktree(wt, true);
  });

  it("applyCommitFiles writes new files and removes deleted files in targetRoot", async () => {
    const { store, baseSha } = await makeStoreWithCommit();
    const wt = path.join(os.tmpdir(), `minimum-wt-apply-${Date.now()}`);
    worktrees.push(wt);
    await store.addWorktree(wt, baseSha);
    fs.writeFileSync(path.join(wt, "out.ts"), "export const x = 1;", "utf-8");
    fs.unlinkSync(path.join(wt, "seed.txt"));
    const toSha = await store.captureWorktreeChanges(wt, "produce output");

    const target = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-apply-"));
    fs.writeFileSync(path.join(target, "seed.txt"), "old", "utf-8");
    try {
      await store.applyCommitFiles(toSha!, baseSha, target);
      expect(fs.existsSync(path.join(target, "out.ts"))).toBe(true);
      expect(fs.readFileSync(path.join(target, "out.ts"), "utf-8")).toBe("export const x = 1;");
      expect(fs.existsSync(path.join(target, "seed.txt"))).toBe(false);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
    await store.removeWorktree(wt, true);
  });

  it("applyCommitFiles is a no-op when commitSha === baseSha", async () => {
    const { store, baseSha } = await makeStoreWithCommit();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-noop-"));
    try {
      // Should not throw and should not modify target
      await store.applyCommitFiles(baseSha, baseSha, target);
      expect(fs.readdirSync(target)).toEqual([]);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("AgentGitStore.gitLog", () => {
  it("returns SHAs in reverse-chronological order", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);

    const sha1 = await store.commitTree(
      [{ relativePath: "a.txt", content: "a" }],
      "first",
      {},
    );
    await store.setRef("refs/minimum/run-log/test", sha1);

    const sha2 = await store.commitTree(
      [{ relativePath: "b.txt", content: "b" }],
      "second",
      { parent: sha1 },
    );
    await store.setRef("refs/minimum/run-log/test", sha2);

    const log = await store.gitLog("refs/minimum/run-log/test");
    expect(log).toHaveLength(2);
    expect(log[0]).toBe(sha2); // most recent first
    expect(log[1]).toBe(sha1);
  });

  it("returns empty array for a missing ref", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);
    expect(await store.gitLog("refs/minimum/does-not-exist")).toEqual([]);
  });

  it("respects maxCount", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
    const store = await AgentGitStore.resolve(tmpDir);

    let parent: string | undefined;
    const shas: string[] = [];
    for (let i = 0; i < 5; i++) {
      const sha = await store.commitTree(
        [{ relativePath: `f${i}.txt`, content: `${i}` }],
        `commit ${i}`,
        { parent },
      );
      parent = sha;
      shas.push(sha);
    }
    await store.setRef("refs/minimum/run-log/many", parent!);

    const log = await store.gitLog("refs/minimum/run-log/many", 3);
    expect(log).toHaveLength(3);
    expect(log[0]).toBe(shas[4]); // most recent
  });
});
