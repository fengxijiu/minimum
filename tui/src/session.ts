import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Message } from './types.js';
import type { ChatHistoryMessage } from './engine.js';

// os.homedir() works cross-platform (USERPROFILE on Windows, HOME on POSIX);
// $HOME alone is empty on Windows and made path.join produce
// "C:\workspace\...\~\.minimum\tui-sessions" - i.e. "~" treated as a literal
// subdirectory under the cwd.
const HOME_DIR = os.homedir();

export interface TuiSession {
  id: string;
  name: string;
  projectPath: string;
  messages: Message[];
  /** Engine ChatMessage[] for AI context restoration on /load. */
  chatHistory?: ChatHistoryMessage[];
  /** NEW: single-agent engine session id for --resume rebinding. */
  engineSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

const sessionsDir = (): string =>
  path.join(HOME_DIR, '.minimum', 'tui-sessions');

/** Cache the freshest session payload for sync flush during shutdown. */
let lastSession: TuiSession | null = null;

export async function saveTuiSession(session: TuiSession): Promise<void> {
  // NEW: cache before async I/O so SIGINT/exit can still flush the latest state.
  lastSession = { ...session, updatedAt: Date.now() };
  const dir = sessionsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${session.id}.json`),
    JSON.stringify(lastSession, null, 2),
    'utf-8',
  );
}

/**
 * Sync-flush the latest TUI session to disk for SIGINT / process.exit paths.
 * Safe even if the async save is still pending because `lastSession` is cached first.
 */
export function flushTuiSessionSync(): void {
  const session = lastSession;
  if (!session) return;
  try {
    const dir = sessionsDir();
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(
      path.join(dir, `${session.id}.json`),
      JSON.stringify(session, null, 2),
      'utf-8',
    );
  } catch { /* best-effort during shutdown */ }
}

export async function loadTuiSessionById(id: string): Promise<TuiSession | null> {
  try {
    const content = await fs.readFile(
      path.join(sessionsDir(), `${id}.json`),
      'utf-8',
    );
    return JSON.parse(content) as TuiSession;
  } catch {
    return null;
  }
}

export async function listTuiSessions(): Promise<TuiSession[]> {
  try {
    const dir = sessionsDir();
    const files = await fs.readdir(dir);
    const sessions: TuiSession[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await fs.readFile(path.join(dir, file), 'utf-8');
        sessions.push(JSON.parse(content) as TuiSession);
      } catch { /* skip malformed */ }
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function loadLatestTuiSession(): Promise<TuiSession | null> {
  const sessions = await listTuiSessions();
  return sessions[0] ?? null;
}

export function formatSessionList(sessions: TuiSession[]): string {
  if (sessions.length === 0) {
    return 'No saved sessions. Use /save [name] to save the current session.';
  }
  const lines = sessions.slice(0, 20).map((s, i) => {
    const d = new Date(s.updatedAt);
    const date = `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    const msgCount = s.messages.filter(m => m.type === 'user' || m.type === 'assistant').length;
    const proj = HOME_DIR ? s.projectPath.replace(HOME_DIR, '~') : s.projectPath;
    return `  ${i + 1}. ${s.name}  (${date})  ${proj}  [${msgCount} msg${msgCount !== 1 ? 's' : ''}]`;
  });
  return `Sessions (${sessions.length}):\n${lines.join('\n')}\nUse /load <name> to restore.`;
}
