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
