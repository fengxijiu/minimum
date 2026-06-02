import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Message } from './types.js';
import type { ChatHistoryMessage } from './engine.js';

export interface TuiSession {
  id: string;
  name: string;
  projectPath: string;
  messages: Message[];
  /** Engine ChatMessage[] for AI context restoration on /load. */
  chatHistory?: ChatHistoryMessage[];
  createdAt: number;
  updatedAt: number;
}

const sessionsDir = (): string =>
  path.join(process.env.HOME ?? '~', '.minimum', 'tui-sessions');

export async function saveTuiSession(session: TuiSession): Promise<void> {
  const dir = sessionsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${session.id}.json`),
    JSON.stringify({ ...session, updatedAt: Date.now() }, null, 2),
    'utf-8',
  );
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

export function formatSessionList(sessions: TuiSession[]): string {
  if (sessions.length === 0) {
    return 'No saved sessions. Use /save [name] to save the current session.';
  }
  const lines = sessions.slice(0, 20).map((s, i) => {
    const d = new Date(s.updatedAt);
    const date = `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    const msgCount = s.messages.filter(m => m.type === 'user' || m.type === 'assistant').length;
    const proj = s.projectPath.replace(process.env.HOME ?? '', '~');
    return `  ${i + 1}. ${s.name}  (${date})  ${proj}  [${msgCount} msg${msgCount !== 1 ? 's' : ''}]`;
  });
  return `Sessions (${sessions.length}):\n${lines.join('\n')}\nUse /load <name> to restore.`;
}
