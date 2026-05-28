import type { Message, ToolKind } from './types.js';

/**
 * UiEvent — mirrors the root package's EngineBridge contract
 * (src/bridge/EngineBridge.ts). Kept structurally identical so a real runner
 * can be `new EngineBridge(createMiMoStack(...).loop)` from the built engine,
 * while the TUI stays decoupled and runnable standalone with the mock.
 */
export type UiEvent =
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; name: string; args: string }
  | { kind: 'tool_result'; name: string; ok: boolean; content: string }
  | { kind: 'notice'; text: string; tone: 'info' | 'warn' | 'ok' }
  | { kind: 'error'; text: string }
  | { kind: 'done'; success: boolean };

export interface Runner {
  send(input: string): AsyncIterable<UiEvent>;
}

const KIND: Record<string, ToolKind> = {
  read_file: 'read', read: 'read',
  list_directory: 'read',
  write_file: 'edit', edit_file: 'edit', edit: 'edit', apply_patch: 'edit',
  exec_shell: 'run', run: 'run',
  grep: 'find', glob: 'find', find: 'find', search: 'find',
  web_fetch: 'find',
  git: 'run', git_status: 'read', git_diff: 'read', git_log: 'read',
};

let seq = 0;
const id = (p: string) => p + Date.now() + '_' + seq++;

/** Translate one normalized engine event into chat messages. */
export function uiEventToMessages(ev: UiEvent): Message[] {
  switch (ev.kind) {
    case 'assistant':
      return [{ id: id('a'), type: 'assistant', text: ev.text }];
    case 'reasoning':
      return [{ id: id('r'), type: 'system', text: ev.text, tone: 'info' }];
    case 'tool':
      return [{ id: id('t'), type: 'tool', tool: { kind: KIND[ev.name] ?? 'read', args: ev.name + ' ' + ev.args } }];
    case 'tool_result':
      return ev.ok
        ? []
        : [{ id: id('e'), type: 'error', error: { title: ev.name + ' failed', lines: ev.content.split('\n').slice(0, 6) } }];
    case 'notice':
      return [{ id: id('n'), type: 'system', text: ev.text, tone: ev.tone }];
    case 'error':
      return [{ id: id('x'), type: 'error', error: { title: 'error', lines: [ev.text] } }];
    case 'done':
      return [];
  }
}

/** Default runner — preserves the standalone mock behavior. */
export const mockRunner: Runner = {
  async *send(_input: string): AsyncIterable<UiEvent> {
    yield { kind: 'assistant', text: '(mock) set MIMO_API_KEY and rebuild the engine (npm run build in the root) to stream live MiMo output.' };
    yield { kind: 'done', success: true };
  },
};

/**
 * Build a live Runner backed by the real MiMo engine.
 *
 * Dynamically imports the built engine from ../../dist/index.js so the TUI
 * package stays dependency-free at compile time. Falls back to mockRunner if:
 *   - MIMO_API_KEY is not set
 *   - the engine has not been built yet
 *   - any import or construction error occurs
 */
export async function createEngineRunner(workingDirectory: string): Promise<Runner> {
  const apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) return mockRunner;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eng = await import('../../dist/index.js') as any;

    const userConfig = await eng.loadMiMoConfig(workingDirectory);
    const client = new eng.MiMoClient({ apiKey, baseUrl: process.env.MIMO_BASE_URL });

    const tools = new eng.ToolRegistry();
    for (const Ctor of [
      eng.ReadFileTool, eng.ListDirectoryTool,
      eng.WriteFileTool, eng.EditFileTool, eng.ApplyPatchTool,
      eng.GrepTool, eng.GlobTool,
      eng.GitTool,
      eng.WebFetchTool,
    ]) {
      tools.register(new Ctor());
    }
    if (process.env.MIMO_ENABLE_SHELL === '1') {
      tools.register(new eng.ExecShellTool());
    }

    const { loop } = eng.createMiMoStack(client, tools, workingDirectory, userConfig);
    return new eng.EngineBridge(loop) as Runner;
  } catch {
    // Engine not built or initialisation failed — degrade gracefully.
    return mockRunner;
  }
}
