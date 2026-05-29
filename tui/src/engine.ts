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

export interface Runner {
  send(input: string): AsyncIterable<UiEvent>;
  resolvePermission?(id: string, decision: ApprovalDecision): void;
  setApprovalMode?(mode: 'read-only' | 'auto-edit' | 'full-auto' | 'suggest' | 'never'): void;
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
export async function createEngineRunner(
  workingDirectory: string,
): Promise<{ runner: Runner; pipelineRunner?: Runner; info: EngineInfo }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let eng: any;
  try {
    eng = await import('../../dist/index.js');
  } catch (err) {
    return { runner: mockRunner, info: fallbackInfo('not-built', String((err as Error)?.message ?? err)) };
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
      return { runner: mockRunner, info: { ...fallbackInfo('no-api-key'), configPath } };
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
    if (process.env.MIMO_ENABLE_SHELL === '1') {
      tools.register(new eng.ExecShellTool());
    }

    const approvalManager = new eng.ApprovalManager({ mode: userConfig.approvalMode ?? 'auto-edit' });
    const { loop } = eng.createMiMoStack(client, tools, workingDirectory, userConfig, { approvalManager });
    const bridge = new eng.EngineBridge(loop, { approvalManager });
    const runner: Runner = {
      send: (input: string) => bridge.send(input),
      resolvePermission: (id, decision) => bridge.resolvePermission(id, decision),
      setApprovalMode: (mode) => approvalManager.setMode(mode),
    };
    // Pipeline (orchestrator) runner — the W0–W4 multi-persona pipeline, run
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
    return { runner, ...(pipelineRunner && { pipelineRunner }), info };
  } catch (err) {
    return { runner: mockRunner, info: fallbackInfo('init-error', String((err as Error)?.message ?? err)) };
  }
}
