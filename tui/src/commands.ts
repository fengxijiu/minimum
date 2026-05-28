import type { AppState, ApprovalMode, Message, PlanStep, Permission } from './types.js';

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
  { name: 'clear',  desc: 'Clear the chat stream',          category: 'view', aliases: ['cls'] },
  // system
  { name: 'approval', desc: 'Set approval mode: read-only | auto-edit | full-auto', category: 'system', usage: '/approval <mode>', aliases: ['appr'] },
  { name: 'run',    desc: 'Run a shell command (asks first)', category: 'system', usage: '/run <cmd>' },
  { name: 'status', desc: 'Show session status',            category: 'system' },
  { name: 'tools',  desc: 'List available tools',           category: 'system' },
  { name: 'model',  desc: 'Show the active model',          category: 'system' },
  { name: 'skill',  desc: 'Manage skills',                  category: 'system', usage: '/skill [list|run]' },
  { name: 'config', desc: 'View configuration',             category: 'system', aliases: ['cfg'] },
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
  | { kind: 'note'; note: string; tone?: 'info' | 'warn' | 'ok' };

let msgSeq = 0;
export function sysMessage(text: string, tone: 'info' | 'warn' | 'ok' = 'info'): Message {
  return { id: 'sys' + Date.now() + '_' + msgSeq++, type: 'system', text, tone };
}

/** Execute a slash command against the current state, returning an outcome. */
export function runCommand(raw: string, state: AppState): CommandOutcome {
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

    case 'compact': {
      const freed = Math.max(0, state.ctx.used - state.ctx.used * 0.4);
      const used = Number((state.ctx.used - freed).toFixed(1));
      return {
        kind: 'patch',
        patch: { ctx: { ...state.ctx, used } },
        note: `Context compacted · freed ~${freed.toFixed(1)}k tokens (now ${used}k/${state.ctx.max}k).`,
        tone: 'ok',
      };
    }

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
        patch: { edits: state.edits.slice(0, -1) },
        note: `Undid edit · ${last.label}.`,
        tone: 'ok',
      };
    }

    case 'redo':
      return { kind: 'note', note: 'Nothing to redo.', tone: 'warn' };

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

    case 'tools':
      return { kind: 'note', note: 'Tools: read · edit · apply_patch · run · find · todo' };

    case 'model':
      return { kind: 'note', note: 'Model: mimo-v2.5-pro · 1.0M ctx · 131k out' };

    case 'memory':
      return { kind: 'note', note: 'Project memory: .mimo/memory.md (none loaded in mock).' };

    case 'config':
      return { kind: 'note', note: 'Config: .minimum/config.json (project) · ~/.minimum/config.json (global)' };

    case 'skill':
      return { kind: 'note', note: 'Skills: type `/skill list` (none registered in mock).' };

    case 'save':
      return { kind: 'note', note: `Session saved${args[0] ? ` as "${args[0]}"` : ''}.`, tone: 'ok' };

    case 'load':
      return args[0]
        ? { kind: 'note', note: `Loaded session "${args[0]}".`, tone: 'ok' }
        : { kind: 'note', note: 'Usage: /load <name>', tone: 'warn' };

    default:
      return { kind: 'note', note: `/${cmd.name} is not wired in the mock yet.`, tone: 'warn' };
  }
}

/** Demo plan used when /new is followed by a task — exported for reuse/tests. */
export const EMPTY_PLAN: { title: string; steps: PlanStep[] } = {
  title: '(no plan yet)',
  steps: [],
};
