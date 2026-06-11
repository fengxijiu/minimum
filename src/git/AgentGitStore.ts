import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { CommitOpts, StoreConfig } from "./types.js";

const execFileAsync = promisify(execFile);

/** Replaces `:`, `\`, `/` with `-` and strips leading dashes. */
function slugifyPath(p: string): string {
  return p.replace(/[/\\:]/g, "-").replace(/^-+/, "");
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
    opts?: CommitOpts,
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

      // Build message with optional trailers.
      let fullMessage = message;
      if (opts?.trailers && Object.keys(opts.trailers).length > 0) {
        fullMessage +=
          "\n\n" +
          Object.entries(opts.trailers)
            // Sanitize values: newlines would corrupt the trailer block.
            .map(([k, v]) => `${k}: ${v.replace(/[\r\n]/g, " ")}`)
            .join("\n");
      }

      const commitArgs = ["commit-tree", treeSha, "-m", fullMessage];
      if (opts?.parent) commitArgs.push("-p", opts.parent);

      const identityEnv: NodeJS.ProcessEnv = {
        GIT_AUTHOR_NAME: "minimum-agent",
        GIT_AUTHOR_EMAIL: "agent@minimum.local",
        GIT_COMMITTER_NAME: "minimum-agent",
        GIT_COMMITTER_EMAIL: "agent@minimum.local",
      };
      const commitSha = await this.git(commitArgs, { env: identityEnv });
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

  async forEachRef(
    pattern: string,
  ): Promise<Array<{ ref: string; sha: string }>> {
    try {
      const output = await this.git([
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        pattern,
      ]);
      if (!output) return [];
      return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const spaceIdx = line.indexOf(" ");
          return {
            ref: line.slice(0, spaceIdx),
            sha: line.slice(spaceIdx + 1),
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Return commit SHAs reachable from `ref` in reverse-chronological order.
   * Returns an empty array if the ref does not exist or the repo is empty.
   */
  async gitLog(ref: string, maxCount?: number): Promise<string[]> {
    try {
      const args = ["log", "--format=%H"];
      if (maxCount !== undefined) args.push(`--max-count=${maxCount}`);
      args.push(ref);
      const output = await this.git(args);
      if (!output) return [];
      return output.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Creates a git worktree at `worktreePath` checked out at `baseSha`. */
  async addWorktree(worktreePath: string, baseSha: string): Promise<void> {
    await this.git(["worktree", "add", "--detach", worktreePath, baseSha]);
  }

  /** Removes a worktree. Swallows errors (worktree may already be gone). */
  async removeWorktree(worktreePath: string, force?: boolean): Promise<void> {
    const args = ["worktree", "remove", worktreePath];
    if (force) args.push("--force");
    try {
      await this.git(args);
    } catch {
      // Swallow: worktree may already be gone
    }
  }

  /**
   * Stages all changes in the worktree and commits them.
   * Returns the commit SHA or null if no changes.
   * Uses `execFileAsync` directly (not `this.git()`) to operate in the worktree context.
   */
  async captureWorktreeChanges(
    worktreePath: string,
    message: string,
  ): Promise<string | null> {
    await execFileAsync("git", ["-C", worktreePath, "add", "-A"], { maxBuffer: 64 * 1024 * 1024 });

    let hasStagedChanges = false;
    try {
      await execFileAsync("git", ["-C", worktreePath, "diff", "--cached", "--quiet"], { maxBuffer: 64 * 1024 * 1024 });
    } catch {
      hasStagedChanges = true;
    }
    if (!hasStagedChanges) return null;

    const identityEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "minimum-agent",
      GIT_AUTHOR_EMAIL: "agent@minimum.local",
      GIT_COMMITTER_NAME: "minimum-agent",
      GIT_COMMITTER_EMAIL: "agent@minimum.local",
    };
    await execFileAsync("git", ["-C", worktreePath, "commit", "-m", message], {
      env: identityEnv,
      maxBuffer: 64 * 1024 * 1024,
    });
    const { stdout } = await execFileAsync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  }

  /**
   * Lists files that differ between two commits.
   * Returns empty array for identical SHAs.
   */
  async listChangedFiles(
    fromSha: string,
    toSha: string,
  ): Promise<Array<{ path: string; deleted: boolean }>> {
    if (fromSha === toSha) return [];
    const output = await this.git(["diff", "--name-status", fromSha, toSha]);
    if (!output) return [];
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const status = line.slice(0, tab);
        const filePath = line.slice(tab + 1);
        return { path: filePath, deleted: status === "D" };
      });
  }

  /**
   * Reads changed files from a commit and writes/deletes them in `targetRoot`.
   */
  async applyCommitFiles(
    commitSha: string,
    baseSha: string,
    targetRoot: string,
  ): Promise<void> {
    const changed = await this.listChangedFiles(baseSha, commitSha);
    for (const { path: relativePath, deleted } of changed) {
      const fullPath = path.join(targetRoot, relativePath);
      if (deleted) {
        await fs.unlink(fullPath).catch(() => {});
      } else {
        // NOTE: readFileAtCommit returns a string; binary files would be corrupted.
        // Acceptable for Phase 4 which handles text-only TypeScript source tasks.
        const content = await this.readFileAtCommit(commitSha, relativePath);
        if (content !== null) {
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, content, "utf-8");
        }
      }
    }
  }

  /**
   * Like {@link applyCommitFiles} but base-aware and binary-safe. A file is a
   * conflict when the main tree's blob OID diverged from `baseSha` (someone else
   * changed it since the worktree forked). Conflicts are left untouched and
   * reported; clean files are applied using raw Buffer writes (no utf-8 decode).
   */
  async applyCommitFilesChecked(
    commitSha: string,
    baseSha: string,
    targetRoot: string,
  ): Promise<{ applied: string[]; conflicts: string[] }> {
    const changed = await this.listChangedFiles(baseSha, commitSha);
    const applied: string[] = [];
    const conflicts: string[] = [];

    for (const { path: relativePath, deleted } of changed) {
      const fullPath = path.join(targetRoot, relativePath);
      const baseOid = await this.blobOidAtCommit(baseSha, relativePath);
      const oursOid = await this.hashFile(fullPath);

      if (oursOid !== baseOid) {
        conflicts.push(relativePath);
        continue;
      }

      if (deleted) {
        await fs.unlink(fullPath).catch(() => {});
      } else {
        const buf = await this.readBlobAtCommit(commitSha, relativePath);
        if (buf !== null) {
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, buf);
        }
      }
      applied.push(relativePath);
    }
    return { applied, conflicts };
  }

  /** Returns the blob SHA for a file at a given commit, or null if not found. */
  async blobOidAtCommit(
    commitSha: string,
    relativePath: string,
  ): Promise<string | null> {
    try {
      return await this.git(["rev-parse", `${commitSha}:${relativePath}`]);
    } catch {
      return null;
    }
  }

  /** Raw blob bytes from a commit; null if the path is absent. Binary-safe. */
  async readBlobAtCommit(commitSha: string, relativePath: string): Promise<Buffer | null> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["show", `${commitSha}:${relativePath}`],
        { cwd: this.config.workTree, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      );
      return stdout as unknown as Buffer;
    } catch {
      return null;
    }
  }

  /** Blob OID git would assign to an on-disk file; null if missing. */
  async hashFile(absPath: string): Promise<string | null> {
    try {
      return await this.git(["hash-object", absPath]);
    } catch {
      return null;
    }
  }

  /** True if the blob at <commit>:<path> contains a NUL byte in its head (binary). */
  async isBinaryAtCommit(commitSha: string, relativePath: string): Promise<boolean> {
    const buf = await this.readBlobAtCommit(commitSha, relativePath);
    if (buf === null) return false;
    return buf.subarray(0, 8000).includes(0);
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

  /**
   * Build a new commit whose tree = `baseCommit`'s tree with every file that
   * changed between `taskBaseSha..taskCommitSha` overlaid (added/modified/deleted).
   *
   * Conflict detection: for each changed file, compares the blob at `baseCommit`
   * (current integrated tree) with the blob at `taskBaseSha` (where the task
   * forked from). If they differ, another task has modified the file since the
   * fork — the file is skipped and reported in `conflictingFiles`.
   *
   * Returns `{ sha, conflictingFiles }`.
   */
  async overlayCommit(
    baseCommit: string,
    taskCommitSha: string,
    taskBaseSha: string,
    message: string,
  ): Promise<{ sha: string; conflictingFiles: string[] }> {
    const tmpIdx = path.join(
      os.tmpdir(),
      `minimum-int-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const conflictingFiles: string[] = [];
    try {
      const idxEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tmpIdx };
      await this.git(["read-tree", baseCommit], { env: idxEnv });
      const changed = await this.listChangedFiles(taskBaseSha, taskCommitSha);
      for (const { path: rel, deleted } of changed) {
        // Conflict check: has another task changed this file on the integrated
        // tree since we forked? Compare the blob at the current integrated
        // commit vs. our fork point.
        const blobAtBase = await this.blobOidAtCommit(baseCommit, rel);
        const blobAtFork = await this.blobOidAtCommit(taskBaseSha, rel);
        if (blobAtBase !== blobAtFork) {
          conflictingFiles.push(rel);
          continue;
        }
        if (deleted) {
          await this.git(["update-index", "--force-remove", rel], { env: idxEnv }).catch(() => {});
        } else {
          const oid = await this.blobOidAtCommit(taskCommitSha, rel);
          if (oid) {
            await this.git(["update-index", "--add", "--cacheinfo", `100644,${oid},${rel}`], {
              env: idxEnv,
            });
          }
        }
      }
      const treeSha = await this.git(["write-tree"], { env: idxEnv });
      const sha = await this.git(["commit-tree", treeSha, "-p", baseCommit, "-m", message], {
        env: {
          ...idxEnv,
          GIT_AUTHOR_NAME: "minimum-agent",
          GIT_AUTHOR_EMAIL: "agent@minimum.local",
          GIT_COMMITTER_NAME: "minimum-agent",
          GIT_COMMITTER_EMAIL: "agent@minimum.local",
        },
      });
      return { sha, conflictingFiles };
    } finally {
      await fs.unlink(tmpIdx).catch(() => {});
    }
  }

  /** Atomically move `ref` from `oldSha` to `newSha`. Returns false if `ref` no longer equals `oldSha`. */
  async compareAndSwapRef(ref: string, oldSha: string, newSha: string): Promise<boolean> {
    try {
      await this.git(["update-ref", ref, newSha, oldSha]);
      return true;
    } catch {
      return false;
    }
  }
}
