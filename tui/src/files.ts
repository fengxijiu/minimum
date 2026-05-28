import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileEntry } from './types.js';

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', '__pycache__', '.venv']);
const MAX_FILES = 30;

type ScannedFile = FileEntry & { mtime: number };

/** Walk the working directory and return up to MAX_FILES recent-ish files. */
export function scanFiles(root: string): FileEntry[] {
  const out: ScannedFile[] = [];
  walk(root, root, out);
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES)
    .map(({ name, meta, staged }) => ({ name, meta, ...(staged !== undefined && { staged }) } as FileEntry));
}

function walk(root: string, dir: string, out: ScannedFile[]): void {
  if (out.length >= MAX_FILES * 4) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.minimum') continue;
    if (IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (!e.isFile()) continue;
    try {
      const st = fs.statSync(full);
      out.push({
        name: path.relative(root, full),
        meta: humanSize(st.size),
        mtime: st.mtimeMs,
      });
    } catch { /* skip */ }
  }
}

function humanSize(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}k`;
  return `${(n / 1024 / 1024).toFixed(1)}m`;
}

/** Best-effort branch name from .git/HEAD. */
export function readBranch(root: string): string {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf-8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (m) return m[1] ?? 'HEAD';
    return head.slice(0, 7);
  } catch {
    return 'no-git';
  }
}

/** LRU push: move (or add) name to the front, cap length, return new list. */
export function touch(files: FileEntry[], entry: FileEntry, max = MAX_FILES): FileEntry[] {
  const filtered = files.filter(f => f.name !== entry.name);
  return [entry, ...filtered].slice(0, max);
}
