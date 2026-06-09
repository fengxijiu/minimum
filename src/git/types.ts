export type RunId  = string; // `run_${timestamp}_${random}`
export type TaskId = string;

export interface FileChange {
  /** Relative path from the work-tree root (forward slashes). */
  relativePath: string;
  /** File content as utf-8 string, or `null` if the file was deleted. */
  content: string | null;
}

export interface StoreConfig {
  /** Absolute path to the `.git` directory (may be a shadow repo). */
  gitDir: string;
  /** Absolute path to the project root used as the work-tree. */
  workTree: string;
}

export interface CommitOpts {
  /** SHA of the parent commit. Omit for an initial (root) commit. */
  parent?: string;
  /**
   * Key-value pairs appended as git trailers after a blank line, e.g.
   *   `{ "Minimum-Run": "run_123", "Minimum-Task": "t-1" }`
   * becomes:
   *   `Minimum-Run: run_123\nMinimum-Task: t-1`
   */
  trailers?: Record<string, string>;
}
