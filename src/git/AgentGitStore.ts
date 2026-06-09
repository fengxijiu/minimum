import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { StoreConfig } from "./types.js";

const execFileAsync = promisify(execFile);

/** Replaces `:`, `\`, `/` with `-` and strips leading dashes. */
function slugifyPath(p: string): string {
  return p.replace(/[:\\/]/g, "-").replace(/^-+/, "");
}

export class AgentGitStore {
  readonly config: StoreConfig;

  constructor(config: StoreConfig) {
    this.config = config;
  }

  /**
   * Resolve or create the git store for `projectRoot`.
   * - If `projectRoot` is inside a git repo, reuses its `.git`.
   * - Otherwise, creates a shadow bare-ish repo at
   *   `~/.minimum/shadow/<slug>/.git` with `projectRoot` as work-tree.
   */
  static async resolve(projectRoot: string): Promise<AgentGitStore> {
    const abs = path.resolve(projectRoot);
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--git-dir"], {
        cwd: abs,
      });
      const rel = stdout.trim();
      const gitDir = path.isAbsolute(rel) ? rel : path.resolve(abs, rel);
      return new AgentGitStore({ gitDir, workTree: abs });
    } catch {
      // Not inside a git repo — create shadow.
      const slug = slugifyPath(abs);
      const shadowBase = path.join(os.homedir(), ".minimum", "shadow", slug);
      const gitDir = path.join(shadowBase, ".git");
      await fs.mkdir(shadowBase, { recursive: true });
      try {
        await execFileAsync("git", ["init", "--separate-git-dir", gitDir, abs], {
          cwd: abs,
        });
      } catch {
        // Already initialised — ignore.
      }
      return new AgentGitStore({ gitDir, workTree: abs });
    }
  }

  /** Run a git command with `GIT_DIR` and `GIT_WORK_TREE` set. */
  private async git(
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; input?: string },
  ): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: this.config.gitDir,
      GIT_WORK_TREE: this.config.workTree,
      ...(opts?.env ?? {}),
    };
    const { stdout } = await execFileAsync("git", args, {
      env,
      cwd: this.config.workTree,
      maxBuffer: 64 * 1024 * 1024,
      ...(opts?.input !== undefined
        ? { input: opts.input } as object
        : {}),
    });
    return stdout.trim();
  }
}
