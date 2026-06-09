import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGitStore } from "../../src/git/AgentGitStore.js";
import { GitSnapshotManager } from "../../src/git/GitSnapshotManager.js";

let tmpDir: string;
let store: AgentGitStore;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-snap-"));
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

describe("GitSnapshotManager.snapshot", () => {
  it("records existing file content before edit", async () => {
    const file = path.join(tmpDir, "a.ts");
    fs.writeFileSync(file, "original");

    const mgr = new GitSnapshotManager(store, "run-1", "task-1");
    await mgr.snapshot(file, tmpDir);

    // Overwrite the file — simulating an agent edit.
    fs.writeFileSync(file, "mutated");

    // Restore should bring back the original.
    const ok = await mgr.restore(file, tmpDir);
    expect(ok).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("original");
  });

  it("handles snapshot of a non-existent file (restore deletes it)", async () => {
    const file = path.join(tmpDir, "new.ts");
    const mgr = new GitSnapshotManager(store, "run-1", "task-2");
    // File does not exist yet.
    await mgr.snapshot(file, tmpDir);

    // Agent creates the file.
    fs.writeFileSync(file, "created by agent");

    const ok = await mgr.restore(file, tmpDir);
    expect(ok).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("is idempotent: snapshotting twice does not overwrite first snapshot", async () => {
    const file = path.join(tmpDir, "b.ts");
    fs.writeFileSync(file, "v1");

    const mgr = new GitSnapshotManager(store, "run-1", "task-3");
    await mgr.snapshot(file, tmpDir);

    fs.writeFileSync(file, "v2");
    await mgr.snapshot(file, tmpDir); // second call — should be no-op

    fs.writeFileSync(file, "v3");
    await mgr.restore(file, tmpDir);

    // Must restore to v1, not v2.
    expect(fs.readFileSync(file, "utf-8")).toBe("v1");

    // Verify a task ref was written to the git store.
    const refs: string = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname)", "refs/minimum/run-1/"],
      { cwd: tmpDir },
    ).toString().trim();
    expect(refs).toContain("refs/minimum/run-1/task/task-3");
  });
});
