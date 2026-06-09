import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGitStore } from "../../src/git/AgentGitStore.js";
import { RunAuditStore } from "../../src/git/RunAuditStore.js";

let tmpDir: string;
let store: AgentGitStore;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-audit-"));
  execFileSync("git", ["init"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: tmpDir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: tmpDir });
  store = await AgentGitStore.resolve(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const slug = tmpDir.replace(/[/\\:]/g, "-").replace(/^-+/, "");
  const shadowBase = path.join(os.homedir(), ".minimum", "shadow", slug);
  fs.rmSync(shadowBase, { recursive: true, force: true });
});

describe("RunAuditStore.setCheckpoint", () => {
  it("creates a ref at the expected path and returns a sha", async () => {
    const audit = new RunAuditStore(store);
    const sha = await audit.setCheckpoint("run-1", "done");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const read = await store.readRef("refs/minimum/run-1/checkpoint/done");
    expect(read).toBe(sha);
  });

  it("idempotent: calling twice updates the ref", async () => {
    const audit = new RunAuditStore(store);
    const sha1 = await audit.setCheckpoint("run-1", "w1-complete");
    const sha2 = await audit.setCheckpoint("run-1", "w1-complete");
    expect(sha1).not.toBe(sha2); // new commit each time
    const ref = await store.readRef("refs/minimum/run-1/checkpoint/w1-complete");
    expect(ref).toBe(sha2); // ref points to latest
  });
});

describe("RunAuditStore.listRuns + listCheckpoints + listTaskRefs", () => {
  it("listRuns returns deduplicated runIds from checkpoint refs", async () => {
    const audit = new RunAuditStore(store);
    await audit.setCheckpoint("run-a", "done");
    await audit.setCheckpoint("run-a", "w1-complete");
    await audit.setCheckpoint("run-b", "done");

    const runs = await audit.listRuns();
    expect(runs.sort()).toEqual(["run-a", "run-b"]);
  });

  it("listRuns returns empty array when no checkpoints exist", async () => {
    const audit = new RunAuditStore(store);
    expect(await audit.listRuns()).toEqual([]);
  });

  it("listCheckpoints returns checkpoints for a specific run", async () => {
    const audit = new RunAuditStore(store);
    await audit.setCheckpoint("run-x", "done");
    await audit.setCheckpoint("run-x", "w3-complete");
    await audit.setCheckpoint("run-y", "done"); // different run, must not appear

    const cps = await audit.listCheckpoints("run-x");
    const phases = cps.map((c) => c.phase).sort();
    expect(phases).toEqual(["done", "w3-complete"]);
  });

  it("listTaskRefs returns task refs for a run", async () => {
    const audit = new RunAuditStore(store);
    // Manually write a task ref (normally done by GitSnapshotManager).
    const sha = await store.commitTree(
      [{ relativePath: "a.ts", content: "x" }],
      "snap",
      {},
    );
    await store.setRef("refs/minimum/run-z/task/task-1", sha);

    const tasks = await audit.listTaskRefs("run-z");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskId).toBe("task-1");
    expect(tasks[0].sha).toBe(sha);
  });
});
