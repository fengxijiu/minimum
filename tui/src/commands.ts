import type { AppState, ApprovalMode, Message, PlanStep, Permission } from './types.js';

export interface CommandContext {
  model?: string;
  tools?: string[];
  configPath?: string;
  memoryPath?: string;
  baseUrl?: string;
  engineMode?: 'engine' | 'mock';
}

export type CommandCategory = 'session' | 'context' | 'view' | 'system';

export interface TuiCommand {
  name: string;        // without leading slash
  desc: string;
  category: CommandCategory;
  usage?: string;
  aliases?: string[];
}

/** The full command catalog surfaced by the slash palette and /help. */
export const COMMANDS: TuiCommand[] = [
  // session
  { name: 'new',    desc: 'Start a fresh session',          category: 'session', aliases: ['reset'] },
  { name: 'save',   desc: 'Save the current session',       category: 'session', usage: '/save [name]' },
  { name: 'load',   desc: 'Load a saved session',           category: 'session', usage: '/load <name>' },
  { name: 'sessions', desc: 'List saved sessions',          category: 'session', aliases: ['ls'] },
  { name: 'quit',   desc: 'Exit minimum',                   category: 'session', aliases: ['exit', 'q'] },
  // context
  { name: 'compact', desc: 'Compact context, free tokens',  category: 'context' },
  { name: 'context', desc: 'Show context window usage',     category: 'context', aliases: ['ctx'] },
  { name: 'undo',    desc: 'Undo the last staged edit',     category: 'context' },
  { name: 'redo',    desc: 'Redo the last undone edit',     category: 'context' },
  { name: 'memory',  desc: 'Show project memory',           category: 'context', aliases: ['mem'] },
  // view
  { name: 'diff',   desc: 'Toggle inline diff blocks',      category: 'view' },
  { name: 'plan',   desc: 'Jump to the plan strip',         category: 'view' },
  { name: 'mode',   desc: 'Switch agent / chat mode',       category: 'view', usage: '/mode <agent|chat>' },
  { name: 'orchestrate', desc: 'Run a request through the W0–W4 pipeline', category: 'view', usage: '/orchestrate <request>', aliases: ['pipeline', 'orch'] },
  { name: 'clear',  desc: 'Clear the chat stream',          category: 'view', aliases: ['cls'] },
  { name: 'verbose', desc: 'Toggle verbose mode',           category: 'view', aliases: ['v'] },
  // system
  { name: 'approval', desc: 'Set approval mode: read-only | auto-edit | full-auto', category: 'system', usage: '/approval <mode>', aliases: ['appr'] },
  { name: 'editmode', desc: 'Set edit mode: review | auto | yolo', category: 'system', usage: '/editmode <mode>' },
  { name: 'run',    desc: 'Run a shell command (asks first)', category: 'system', usage: '/run <cmd>' },
  { name: 'mcp',    desc: 'Show MCP server status',         category: 'system' },
  { name: 'status', desc: 'Show session status',            category: 'system' },
  { name: 'tools',  desc: 'List available tools',           category: 'system' },
  { name: 'model',  desc: 'Show the active model',          category: 'system' },
  { name: 'skill',  desc: 'Manage skills',                  category: 'system', usage: '/skill [list|run]' },
  { name: 'config', desc: 'View configuration',             category: 'system', aliases: ['cfg'] },
  { name: 'init',   desc: 'Initialize .mimo/config.json for this project', category: 'system' },
  { name: 'help',   desc: 'Show keys & commands',           category: 'system', aliases: ['?'] },
];

const NAME_INDEX = new Map<string, TuiCommand>();
for (const c of COMMANDS) {
  NAME_INDEX.set(c.name, c);
  for (const a of c.aliases ?? []) NAME_INDEX.set(a, c);
}

/** Fuzzy-ish prefix filter for the palette. Empty query → all commands. */
export function filterCommands(query: string): TuiCommand[] {
  const q = query.replace(/^\//, '').trim().toLowerCase();
  if (!q) return COMMANDS;
  const starts: TuiCommand[] = [];
  const contains: TuiCommand[] = [];
  for (const c of COMMANDS) {
    const hay = [c.name, ...(c.aliases ?? [])];
    if (hay.some(h => h.startsWith(q))) starts.push(c);
    else if (c.name.includes(q) || c.desc.toLowerCase().includes(q)) contains.push(c);
  }
  return [...starts, ...contains];
}

export type CommandOutcome =
  | { kind: 'patch'; patch: Partial<AppState>; note?: string; tone?: 'info' | 'warn' | 'ok' }
  | { kind: 'help' }
  | { kind: 'quit' }
  | { kind: 'permission'; perm: Permission }
  | { kind: 'note'; note: string; tone?: 'info' | 'warn' | 'ok' }
  | { kind: 'pipeline'; text: string }
  | { kind: 'event'; event: import('./state/events.js').AgentEvent };

let msgSeq = 0;
export function sysMessage(text: string, tone: 'info' | 'warn' | 'ok' = 'info'): Message {
  return { id: 'sys' + Date.now() + '_' + msgSeq++, type: 'system', text, tone };
}

/** Execute a slash command against the current state, returning an outcome. */
export function runCommand(raw: string, state: AppState, ctx: CommandContext = {}): CommandOutcome {
  const parts = raw.replace(/^\//, '').trim().split(/\s+/);
  const name = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1);
  const cmd = NAME_INDEX.get(name);

  if (!cmd) {
    return { kind: 'note', note: `Unknown command: /${name} — type /help`, tone: 'warn' };
  }

  switch (cmd.name) {
    case 'help':
      return { kind: 'help' };

    case 'quit':
      return { kind: 'quit' };

    case 'clear':
      return { kind: 'patch', patch: { messages: [] }, note: 'Chat cleared.', tone: 'ok' };

    case 'new':
      return {
        kind: 'patch',
        patch: {
          messages: [],
          edits: [],
          redo: [],
          plan: { title: '(no plan yet)', steps: [] },
          currentStepLabel: '',
        },
        note: 'Started a fresh session.',
        tone: 'ok',
      };

    case 'mode': {
      const target = args[0] === 'chat' || args[0] === 'agent'
        ? args[0]
        : state.mode === 'agent' ? 'chat' : 'agent';
      return { kind: 'patch', patch: { mode: target }, note: `Mode → ${target}.`, tone: 'ok' };
    }

    case 'orchestrate': {
      const request = args.join(' ').trim();
      if (!request) {
        return { kind: 'note', note: 'Usage: /orchestrate <request>', tone: 'warn' };
      }
      return { kind: 'pipeline', text: request };
    }

    case 'compact':
      return {
        kind: 'note',
        note: ctx.engineMode === 'engine'
          ? 'Compaction is automatic — the engine folds context when usage crosses the threshold.'
          : `Context ${state.ctx.used}k / ${state.ctx.max}k · compaction runs automatically in the engine.`,
      };

    case 'context':
      return {
        kind: 'note',
        note: `Context ${state.ctx.used}k / ${state.ctx.max}k (${Math.round((state.ctx.used / state.ctx.max) * 100)}% used) · ${state.files.length} files in scope.`,
      };

    case 'diff': {
      const hasDiff = state.messages.some(m => m.type === 'diff');
      return {
        kind: 'note',
        note: hasDiff ? 'Toggled inline diff blocks.' : 'No diffs in this session yet.',
      };
    }

    case 'plan': {
      const done = state.plan.steps.filter(s => s.status === 'done').length;
      return {
        kind: 'note',
        note: state.plan.steps.length
          ? `Plan "${state.plan.title}" — ${done}/${state.plan.steps.length} steps done.`
          : 'No active plan. Describe a task to generate one.',
      };
    }

    case 'undo': {
      if (!state.edits.length) return { kind: 'note', note: 'Nothing to undo.', tone: 'warn' };
      const last = state.edits[state.edits.length - 1]!;
      return {
        kind: 'patch',
        patch: { edits: state.edits.slice(0, -1), redo: [...state.redo, last] },
        note: `Undid edit · ${last.label}.`,
        tone: 'ok',
      };
    }

    case 'redo': {
      if (!state.redo.length) return { kind: 'note', note: 'Nothing to redo.', tone: 'warn' };
      const last = state.redo[state.redo.length - 1]!;
      return {
        kind: 'patch',
        patch: { edits: [...state.edits, last], redo: state.redo.slice(0, -1) },
        note: `Redid edit · ${last.label}.`,
        tone: 'ok',
      };
    }

    case 'status':
      return {
        kind: 'note',
        note: `${state.path} · ${state.branch} · ${state.mode} · ${state.edits.length} staged · ctx ${state.ctx.used}k/${state.ctx.max}k`,
      };

    case 'run': {
      const cmd = args.join(' ') || 'pytest -q';
      return {
        kind: 'permission',
        perm: {
          tool: 'run shell',
          cmd: `$ ${cmd}`,
          cwd: state.path,
          note: "this command can read files and start processes. it can't reach the network.",
        },
      };
    }

    case 'approval': {
      const MODES: ApprovalMode[] = ['read-only', 'auto-edit', 'full-auto'];
      const current = state.approvalMode;
      const target = (args[0] as ApprovalMode | undefined) ??
        MODES[(MODES.indexOf(current) + 1) % MODES.length]!;
      if (!MODES.includes(target)) {
        return { kind: 'note', note: `Unknown approval mode "${target}". Valid: ${MODES.join(' | ')}`, tone: 'warn' };
      }
      const labels: Record<ApprovalMode, string> = {
        'read-only': 'read-only — writes blocked',
        'auto-edit': 'auto-edit — file writes allowed, shell needs confirmation',
        'full-auto': 'full-auto — unrestricted',
      };
      return { kind: 'patch', patch: { approvalMode: target }, note: `Approval mode → ${labels[target]}.`, tone: 'ok' };
    }

    case 'tools': {
      const list = ctx.tools && ctx.tools.length
        ? ctx.tools.join(' · ')
        : 'read · edit · apply_patch · run · find · todo (mock)';
      return { kind: 'note', note: `Tools: ${list}` };
    }

    case 'model': {
      const model = ctx.model ?? 'mimo-v2.5-pro';
      const mode = ctx.engineMode === 'engine' ? 'engine' : 'mock';
      return { kind: 'note', note: `Model: ${model} · ${mode} · ctx ${state.ctx.max}k` };
    }

    case 'memory':
      return {
        kind: 'note',
        note: ctx.memoryPath
          ? `Project memory: ${ctx.memoryPath} (loaded if present).`
          : 'Project memory: .minimum/memory.md (none configured).',
      };

    case 'config': {
      const lines = [
        `engine: ${ctx.engineMode ?? 'mock'}`,
        ctx.model ? `model: ${ctx.model}` : null,
        ctx.baseUrl ? `baseUrl: ${ctx.baseUrl}` : null,
        ctx.configPath ? `global: ${ctx.configPath}` : null,
        'project: .minimum/config.json',
        `approval: ${state.approvalMode}`,
      ].filter(Boolean).join(' · ');
      return { kind: 'note', note: `Config — ${lines}` };
    }

    case 'skill':
      return { kind: 'note', note: 'Skills: type `/skill list` (none registered).' };

    case 'sessions':
      return { kind: 'note', note: 'Saved sessions: (none). Use /save <name> and /load <name>.' };

    case 'verbose':
      return { kind: 'event', event: { type: 'verbose.toggle' } };

    case 'editmode': {
      const MODES = ['review', 'auto', 'yolo'] as const;
      const target = args[0] as typeof MODES[number] | undefined;
      if (target && MODES.includes(target)) {
        return { kind: 'event', event: { type: 'edit.mode.change', mode: target } };
      }
      return { kind: 'note', note: `Edit mode: ${state.editMode}. Usage: /editmode <review|auto|yolo>` };
    }

    case 'mcp':
      return {
        kind: 'note',
        note: state.mcpLoading
          ? `MCP: loading ${state.mcpLoading.ready}/${state.mcpLoading.total} servers`
          : 'MCP: no servers configured. Add MCP servers in .mimo/config.json',
      };

    case 'init':
      return { kind: 'event', event: { type: 'init.run', cwd: state.path, args } };

    case 'save':
      return { kind: 'note', note: `Session saved${args[0] ? ` as "${args[0]}"` : ''}.`, tone: 'ok' };

    case 'load':
      return args[0]
        ? { kind: 'note', note: `Loaded session "${args[0]}".`, tone: 'ok' }
        : { kind: 'note', note: 'Usage: /load <name>', tone: 'warn' };

    default:
      return { kind: 'note', note: `/${cmd.name} is not wired yet.`, tone: 'warn' };
  }
}

/** Demo plan used when /new is followed by a task — exported for reuse/tests. */
export const EMPTY_PLAN: { title: string; steps: PlanStep[] } = {
  title: '(no plan yet)',
  steps: [],
};
