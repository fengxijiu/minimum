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
  const slug = tmpDir.replace(/[:\\/]/g, "-").replace(/^-+/, "");
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
    const slug = tmpDir.replace(/[:\\/]/g, "-").replace(/^-+/, "");
    const expected = path.join(os.homedir(), ".minimum", "shadow", slug, ".git");
    expect(store.config.gitDir).toBe(expected);
    expect(store.config.workTree).toBe(tmpDir);
    expect(fs.existsSync(store.config.gitDir)).toBe(true);
  });
});
