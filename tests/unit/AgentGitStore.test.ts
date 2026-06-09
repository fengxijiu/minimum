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
