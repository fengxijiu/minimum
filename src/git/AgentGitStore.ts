import { execFile, spawn } from "node:child_process";
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
        await execFileAsync("git", ["init", "--bare", gitDir], {});
      } catch (err) {
        // Only ignore the error if gitDir was created anyway (concurrent init race).
        const exists = await fs.stat(gitDir).then(() => true).catch(() => false);
        if (!exists) throw err;
      }
      return new AgentGitStore({ gitDir, workTree: abs });
    }
  }

  /** Run a git command with `GIT_DIR` and `GIT_WORK_TREE` set. */
  private async git(
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; input?: string; raw?: boolean },
  ): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: this.config.gitDir,
      GIT_WORK_TREE: this.config.workTree,
      ...(opts?.env ?? {}),
    };

    if (opts?.input !== undefined) {
      // Use spawn so we can write to stdin properly.
      return new Promise<string>((resolve, reject) => {
        const child = spawn("git", args, {
          env,
          cwd: this.config.workTree,
        });
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        child.stdout.on("data", (d: Buffer) => chunks.push(d));
        child.stderr.on("data", (d: Buffer) => errChunks.push(d));
        child.on("error", reject);
        child.stdin.on("error", () => {
          // Swallow EPIPE — close event fires with nonzero exit, handled below
        });
        child.on("close", (code) => {
          if (code !== 0) {
            const msg = Buffer.concat(errChunks).toString();
            reject(new Error(`git ${args.join(" ")} exited ${code}: ${msg}`));
          } else {
            const out = Buffer.concat(chunks).toString();
            resolve(opts.raw ? out : out.trim());
          }
        });
        child.stdin.write(opts.input as string);
        child.stdin.end();
      });
    }

    const { stdout } = await execFileAsync("git", args, {
      env,
      cwd: this.config.workTree,
      maxBuffer: 64 * 1024 * 1024,
    });
    return opts?.raw ? stdout : stdout.trim();
  }

  /**
   * Creates a git commit from an array of FileChange using an isolated temp
   * index (GIT_INDEX_FILE). Files with `content: null` are skipped (deletion
   * marker — not added to the tree). Returns the commit sha.
   */
  async commitTree(
    files: import("./types.js").FileChange[],
    message: string,
    parent?: string,
  ): Promise<string> {
    const tmpIdx = path.join(
      os.tmpdir(),
      `minimum-idx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const idxEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tmpIdx };

      // Start with an empty index.
      await this.git(["read-tree", "--empty"], { env: idxEnv });

      // Hash each file into the object store and stage it.
      for (const f of files) {
        if (f.content === null) continue; // deleted — not added to tree
        const blobSha = await this.git(["hash-object", "-w", "--stdin"], {
          env: idxEnv,
          input: f.content,
        });
        await this.git(
          [
            "update-index",
            "--add",
            "--cacheinfo",
            `100644,${blobSha},${f.relativePath}`,
          ],
          { env: idxEnv },
        );
      }

      const treeSha = await this.git(["write-tree"], { env: idxEnv });

      const commitArgs = ["commit-tree", treeSha, "-m", message];
      if (parent) commitArgs.push("-p", parent);

      const commitSha = await this.git(commitArgs);
      return commitSha;
    } finally {
      await fs.unlink(tmpIdx).catch(() => {});
    }
  }

  /** Writes a ref. */
  async setRef(ref: string, sha: string): Promise<void> {
    await this.git(["update-ref", ref, sha]);
  }

  /** Reads a ref, returns null if missing. */
  async readRef(ref: string): Promise<string | null> {
    try {
      return await this.git(["rev-parse", ref]);
    } catch {
      return null;
    }
  }

  /** Gets file content from a commit; returns null if not found. */
  async readFileAtCommit(
    commitSha: string,
    relativePath: string,
  ): Promise<string | null> {
    try {
      return await this.git(["show", `${commitSha}:${relativePath}`], { raw: true });
    } catch {
      return null;
    }
  }

  /** Stores a blob in the object store, returns its sha. */
  async storeBlob(content: string): Promise<string> {
    return this.git(["hash-object", "-w", "--stdin"], { input: content });
  }

  /** Retrieves blob content by sha; returns null if not found. */
  async readBlob(sha: string): Promise<string | null> {
    try {
      return await this.git(["cat-file", "blob", sha], { raw: true });
    } catch {
      return null;
    }
  }
}
