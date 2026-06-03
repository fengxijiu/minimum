import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// $HOME wins so tests can redirect via env; os.homedir() is the cross-platform
// fallback on Windows where HOME is normally empty. The literal "~" tail that
// used to live in this chain is gone — it produced cwd-relative paths.
const HIST_DIR = path.join(process.env.HOME ?? os.homedir(), '.minimum');
const HIST_FILE = path.join(HIST_DIR, 'history.jsonl');
const MAX_ENTRIES = 500;

export interface HistoryEntry { text: string; ts: number; }

/** Best-effort sync read; never throws — empty array on missing/bad file. */
export function loadHistory(): HistoryEntry[] {
  try {
    const raw = fs.readFileSync(HIST_FILE, 'utf-8');
    const out: HistoryEntry[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t);
        if (typeof e?.text === 'string') out.push({ text: e.text, ts: Number(e.ts) || 0 });
      } catch { /* skip malformed */ }
    }
    return out.slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

/** Append one entry; rotates when over MAX_ENTRIES. Silent on IO errors. */
export function appendHistory(text: string): void {
  const t = text.trim();
  if (!t) return;
  try {
    fs.mkdirSync(HIST_DIR, { recursive: true });
    const entry = JSON.stringify({ text: t, ts: Date.now() }) + '\n';
    fs.appendFileSync(HIST_FILE, entry, 'utf-8');
    // Rotation: cheap check by size; rewrite if too large.
    const stat = fs.statSync(HIST_FILE);
    if (stat.size > MAX_ENTRIES * 512) {
      const kept = loadHistory();
      fs.writeFileSync(HIST_FILE, kept.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
    }
  } catch { /* ignore */ }
}

export const HISTORY_FILE = HIST_FILE;
export const HISTORY_LIMIT = MAX_ENTRIES;
