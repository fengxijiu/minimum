import * as os from 'node:os';
import * as path from 'node:path';
import type { Message, ToolKind } from './types.js';

export type EngineMode = 'engine' | 'mock';
export type EngineFallbackReason = 'no-api-key' | 'not-built' | 'init-error';

export interface EngineInfo {
  mode: EngineMode;
  reason?: EngineFallbackReason;
  error?: string;
  model?: string;
  baseUrl?: string;
  tools?: string[];
  configPath?: string;
  memoryPath?: string;
}

/**
 * UiEvent — mirrors the root package's EngineBridge contract
 * (src/bridge/EngineBridge.ts).
 */
export type UiPlanStatus = 'pending' | 'in_progress' | 'completed';
export interface UiPlanStep { label: string; status: UiPlanStatus; }

export type UiRisk = 'low' | 'medium' | 'high';

export type UiEvent =
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; name: string; args: string }
  | { kind: 'tool_result'; name: string; ok: boolean; content: string }
  | { kind: 'notice'; text: string; tone: 'info' | 'warn' | 'ok' }
  | { kind: 'error'; text: string }
  | { kind: 'usage'; totalTokens: number; toolCalls: number; steps: number; totalCostUsd: number }
  | { kind: 'plan'; steps: UiPlanStep[] }
  | { kind: 'permission_request'; id: string; tool: string; args: Record<string, unknown>; risk: UiRisk; description: string }
  | { kind: 'pipeline'; phase: string; label: string; detail?: string }
  | { kind: 'done'; success: boolean }
  | { kind: 'streaming'; text: string }
  | { kind: 'streaming_reasoning'; text: string }
  | { kind: 'streaming_start' }
  | { kind: 'streaming_end' };

export type ApprovalDecision = { approved: boolean; reason?: string; remembered?: boolean };

export type ChatHistoryMessage = { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string };

export interface Runner {
  send(input: string): AsyncIterable<UiEvent>;
  resolvePermission?(id: string, decision: ApprovalDecision): void;
  setApprovalMode?(mode: 'read-only' | 'auto-edit' | 'full-auto' | 'suggest' | 'never'): void;
  /** Return the engine's current conversation history for session persistence. */
  getHistory?(): ChatHistoryMessage[];
  /** Seed the engine with a prior conversation history (used by /load). */
  loadHistory?(messages: ChatHistoryMessage[]): void;
  /** Enable or disable plan mode (blocks mutating tools so the AI only plans). */
  setPlanMode?(enabled: boolean): void;
  /** One-shot text completion used by local command services such as /learn. */
  completeText?(prompt: string): Promise<string>;
  /** Refresh command-visible learned skills after /learn apply --load. */
  reloadSkills?(): Promise<void>;
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

/** Convert raw JSON args into a compact human-readable summary. */
export function summarizeTool(name: string, rawArgs: string): string {
  try {
    const a: Record<string, unknown> = JSON.parse(rawArgs);
    switch (name) {
      case 'read_file': case 'read': {
        const p = String(a.path ?? a.file_path ?? a.filepath ?? '');
        const s = a.start_line != null ? `:${a.start_line}` : '';
        const e = a.end_line   != null ? `–${a.end_line}`   : '';
        return p + s + e;
      }
      case 'list_directory':
        return String(a.path ?? a.directory ?? '.');
      case 'write_file': case 'edit_file': case 'edit': case 'apply_patch':
        return String(a.path ?? a.file_path ?? a.filepath ?? '').slice(0, 80);
      case 'exec_shell': case 'run':
        return String(a.command ?? rawArgs).slice(0, 80);
      case 'grep':
        return `"${a.pattern ?? ''}" in ${a.path ?? '.'}`;
      case 'glob': case 'find': case 'search':
        return String(a.pattern ?? a.path ?? rawArgs).slice(0, 60);
      case 'git': case 'git_status': case 'git_diff': case 'git_log':
        return String(a.command ?? a.subcommand ?? name).slice(0, 60);
      case 'web_fetch':
        return String(a.url ?? rawArgs).slice(0, 80);
      case 'todo_write': case 'todo_read':
        return String(a.title ?? a.id ?? 'todo').slice(0, 40);
      default:
        return rawArgs.slice(0, 80);
    }
  } catch {
    return String(rawArgs).slice(0, 80);
  }
}

/**
 * Expand a permission request's args into per-parameter detail lines so the
 * user can see exactly what they're approving — not just the headline command.
 * Returns "key: value" lines, value-truncated, longest/destructive params first.
 */
export function describePermissionArgs(rawArgs: Record<string, unknown>): string[] {
  const KEY_ORDER = ['command', 'path', 'file_path', 'filepath', 'url', 'pattern', 'content', 'cwd', 'timeout'];
  const entries = Object.entries(rawArgs ?? {});
  entries.sort(([a], [b]) => {
    const ia = KEY_ORDER.indexOf(a), ib = KEY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const lines: string[] = [];
  for (const [k, v] of entries) {
    let val: string;
    if (v == null) val = String(v);
    else if (typeof v === 'string') val = v;
    else if (typeof v === 'object') val = JSON.stringify(v);
    else val = String(v);
    val = val.replace(/\s+/g, ' ').trim();
    // content/large bodies: show length instead of dumping
    if (k === 'content' && val.length > 60) {
      lines.push(`${k}: ${val.length} chars`);
    } else {
      lines.push(`${k}: ${val.slice(0, 72)}${val.length > 72 ? '…' : ''}`);
    }
  }
  return lines.slice(0, 8);
}

/** Build a brief result summary for display in tool meta. */
export function summarizeToolResult(ok: boolean, content: string): string {
  if (!ok) return '';
  const trimmed = content.trim();
  if (!trimmed) return '✓';
  const lines = trimmed.split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) return '✓';
  // Single-line result — show verbatim (truncated).
  if (lines.length === 1) return lines[0]!.slice(0, 80);
  // Diff output — count +/- lines.
  const added   = lines.filter(l => l.startsWith('+')).length;
  const removed = lines.filter(l => l.startsWith('-')).length;
  if (added > 0 || removed > 0) return `+${added} −${removed}`;
  // Exit code.
  const exitM = content.match(/exit\s+(\d+)/i);
  if (exitM) return `exit ${exitM[1]}`;
  // JSON object — surface top-level keys so the user knows what was returned.
  if (trimmed.startsWith('{')) {
    try {
      const keys = Object.keys(JSON.parse(trimmed)).slice(0, 4);
      if (keys.length) return `{${keys.join(', ')}}`;
    } catch { /* not JSON */ }
  }
  // Multi-line plain text — show line count.
  return `${lines.length} ln`;
}

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
    case 'usage':
    case 'plan':
    case 'permission_request':
    case 'pipeline':
    case 'done':
    case 'streaming':
    case 'streaming_reasoning':
    case 'streaming_start':
    case 'streaming_end':
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

function fallbackInfo(reason: EngineFallbackReason, error?: string): EngineInfo {
  return {
    mode: 'mock',
    reason,
    error,
    configPath: path.join(process.env.HOME ?? os.homedir() ?? '~', '.minimum', 'config.json'),
  };
}

/**
 * Build a live Runner backed by the real MiMo engine.
 *
 * Dynamically imports the built engine from ../../dist/index.js so the TUI
 * package stays dependency-free at compile time.
 *
 * @throws if MIMO_API_KEY is not set or engine fails to initialize.
 */
export interface SessionFlusher {
  flushSync(): void;
}

/**
 * TuiConfirmationGate — TUI-backed ConfirmationGate.
 * Call gate.onShow to receive payloads; call gate.resolve(verdict) to unblock ask().
 */
export class TuiConfirmationGate {
  private resolver: ((v: { type: 'pick'; optionId: string } | { type: 'text'; text: string } | { type: 'cancel' }) => void) | null = null;
  onShow: ((payload: { question: string; options: Array<{ id: string; title: string; summary?: string }>; allowCustom: boolean }) => void) | null = null;

  ask(payload: { question: string; options: Array<{ id: string; title: string; summary?: string }>; allowCustom: boolean }): Promise<{ type: 'pick'; optionId: string } | { type: 'text'; text: string } | { type: 'cancel' }> {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.onShow?.(payload);
    });
  }

  resolve(verdict: { type: 'pick'; optionId: string } | { type: 'text'; text: string } | { type: 'cancel' }): void {
    const r = this.resolver;
    this.resolver = null;
    r?.(verdict);
  }
}

export async function createEngineRunner(
  workingDirectory: string,
): Promise<{ runner: Runner; pipelineRunner?: Runner; info: EngineInfo; sessionFlusher?: SessionFlusher; choiceGate: TuiConfirmationGate }> {
  const choiceGate = new TuiConfirmationGate();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let eng: any;
  try {
    eng = await import('../../dist/index.js');
  } catch (err) {
    return { runner: mockRunner, info: fallbackInfo('not-built', String((err as Error)?.message ?? err)), choiceGate };
  }

  try {
    // 凭证优先级：env > 项目配置 > ~/.minimum/config.json
    const userConfig = await eng.loadMiMoConfig(workingDirectory);
    const apiKey = process.env.MIMO_API_KEY || userConfig.apiKey;
    // Explicit URL (env or config) wins; otherwise auto-select by key prefix:
    // "tp-" → Token Plan CN endpoint, "sk-" → standard pay-as-you-go endpoint.
    const explicitBaseUrl = process.env.MIMO_BASE_URL || userConfig.baseUrl;
    const baseUrl: string = explicitBaseUrl
      || (apiKey?.startsWith('tp-')
          ? 'https://token-plan-cn.xiaomimimo.com/v1'
          : 'https://api.xiaomimimo.com/v1');
    const configPath = eng.getGlobalConfigPath?.() ?? path.join(process.env.HOME ?? os.homedir() ?? '~', '.minimum', 'config.json');
    if (!apiKey) {
      return { runner: mockRunner, info: { ...fallbackInfo('no-api-key'), configPath }, choiceGate };
    }

    const client = new eng.MiMoClient({ apiKey, baseUrl });

    const tools = new eng.ToolRegistry();
    for (const Ctor of [
      eng.ReadFileTool, eng.ListDirectoryTool,
      eng.WriteFileTool, eng.EditFileTool, eng.ApplyPatchTool,
      eng.GrepTool, eng.GlobTool,
      eng.GitTool,
      eng.WebFetchTool,
      eng.TodoWriteTool,
    ]) {
      tools.register(new Ctor());
    }
    const approvalManager = new eng.ApprovalManager({ mode: userConfig.approvalMode ?? 'auto-edit' });
    const { loop, sessionManager } = eng.createMiMoStack(client, tools, workingDirectory, userConfig, { approvalManager, confirmationGate: choiceGate });

    // Wire learned skills into the single-agent system context using a two-tier approach:
    //   • Brief catalog  — always shown: name + one-line description + trigger keywords
    //   • Full expansion — only for skills whose triggers/tags match the current user input
    // This keeps the system context small when skills are irrelevant, and rich when they're not.
    const skillsSystemContent = async (userInput: string): Promise<string> => {
      try {
        type Skill = { name: string; description: string; prompt: string; triggers: string[]; capability_tags: string[] };
        const skills: Skill[] = await eng.loadLearnedSkills(workingDirectory);
        if (!skills.length) return '';

        // Tier 1: brief catalog — always shown, one line per skill
        const catalogLines = skills.map((s: Skill) => {
          const kws = [...s.triggers, ...s.capability_tags].slice(0, 4).join(', ');
          return `- **${s.name}**: ${s.description}${kws ? `  _(triggers: ${kws})_` : ''}`;
        });

        // Tier 2: full expansion — only for skills whose triggers/tags appear in the user input
        const inputLower = userInput.toLowerCase();
        const expanded: string[] = [];
        if (inputLower) {
          for (const s of skills) {
            const triggered =
              s.triggers.some((t: string) => inputLower.includes(t.toLowerCase())) ||
              s.capability_tags.some((t: string) => inputLower.includes(t.toLowerCase())) ||
              inputLower.includes(s.name.toLowerCase());
            if (triggered) {
              expanded.push(`### ${s.name} (active)\n${s.prompt}`);
            }
          }
        }

        const parts: string[] = [
          '# Project-Local Learned Skills',
          '',
          'Available skills (apply when the task matches):',
          ...catalogLines,
        ];
        if (expanded.length) {
          parts.push('', '## Expanded Skills (matched to current task)', '', ...expanded);
        }
        return parts.join('\n');
      } catch {
        return '';
      }
    };
    loop.configure({ skillsSystemContent });

    const bridge = new eng.EngineBridge(loop, { approvalManager });
    const runner: Runner = {
      send: (input: string) => bridge.send(input),
      resolvePermission: (id, decision) => bridge.resolvePermission(id, decision),
      setApprovalMode: (mode) => approvalManager.setMode(mode),
      getHistory: () => bridge.getHistory(),
      loadHistory: (msgs) => bridge.loadHistory(msgs),
      setPlanMode: (enabled) => bridge.setPlanMode(enabled),
      completeText: async (prompt: string) => {
        const response = await client.chat({
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 8192,
          temperature: 0.2,
        });
        return response.content;
      },
      reloadSkills: async () => {
        // Skills are re-read on every turn via skillsSystemContent — no cache to bust.
        // Calling reloadSkills is a no-op at the engine level; the next turn will pick up changes.
      },
    };
    const sessionFlusher: SessionFlusher | undefined = sessionManager
      ? { flushSync: () => sessionManager.flushSync() }
      : undefined;
    // Pipeline (orchestrator) runner — the W0–W4 multi-persona pipeline with W3.5, run
    // through the same client behind the Runner contract. Optional: only wired
    // when the built engine exposes PipelineBridge.
    let pipelineRunner: Runner | undefined;
    if (eng.PipelineBridge) {
      const pipelineBridge = new eng.PipelineBridge(client, { projectRoot: workingDirectory });
      pipelineRunner = { send: (input: string) => pipelineBridge.send(input) };
    }
    const toolNames: string[] = (tools.getDefinitions?.() ?? []).map((d: { name: string }) => d.name);
    const info: EngineInfo = {
      mode: 'engine',
      model: userConfig.defaultModel ?? 'mimo-v2.5-pro',
      baseUrl: baseUrl,
      tools: toolNames,
      configPath,
      memoryPath: path.join(workingDirectory, '.minimum', 'memory.md'),
    };
    return { runner, ...(pipelineRunner && { pipelineRunner }), info, ...(sessionFlusher && { sessionFlusher }), choiceGate };
  } catch (err) {
    return { runner: mockRunner, info: fallbackInfo('init-error', String((err as Error)?.message ?? err)), choiceGate };
  }
}
