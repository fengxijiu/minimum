import type { AppState, ApprovalMode, Message, PlanStep, Permission, FileEntry } from './types.js';
import { loadLearnedSkillsSync } from '../../dist/skills/LearnedSkillLoader.js';

export interface SkillEntry {
  name: string;
  description: string;
  tags: string[];
  prompt: string;
}

/** Built-in skill catalog — each entry defines the pipeline prompt injected on `/skill run`. */
export const SKILL_CATALOG: SkillEntry[] = [
  {
    name: 'code-review',
    description: 'Review code for issues: completeness, correctness, error handling, and type safety',
    tags: ['code', 'review', 'quality'],
    prompt: 'Review the code in the current project for issues including completeness, correctness, error handling, and TypeScript type safety. Group findings by severity (error / warning / info) and suggest concrete fixes.',
  },
  {
    name: 'refactor',
    description: 'Suggest the most impactful refactoring improvements',
    tags: ['code', 'refactor', 'improvement'],
    prompt: 'Analyze the code in the current project and identify the most impactful refactoring opportunities. For each suggestion explain the benefit, the files involved, and provide a concrete before/after example.',
  },
  {
    name: 'test-generator',
    description: 'Generate unit tests following existing project patterns',
    tags: ['testing', 'unit-test', 'automation'],
    prompt: 'Generate comprehensive unit tests for the source files in this project. Follow the existing test framework and conventions you find. Cover the happy path, edge cases, and error paths for each exported function or class.',
  },
  {
    name: 'documentation',
    description: 'Generate clear documentation with signatures, params, and examples',
    tags: ['docs', 'documentation', 'generation'],
    prompt: 'Generate clear and concise documentation for the public API of this project. Include function/method signatures, parameter and return type descriptions, thrown errors, and a usage example for each exported symbol.',
  },
];

export interface CommandContext {
  model?: string;
  tools?: string[];
  configPath?: string;
  memoryPath?: string;
  baseUrl?: string;
  engineMode?: 'engine' | 'mock';
  /** MCP servers that connected at startup. */
  mcpServers?: string[];
  /** Number of MCP tools registered across all connected servers. */
  mcpToolCount?: number;
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
  { name: 'copy',   desc: 'Copy last reply to clipboard',   category: 'view' },
  { name: 'diff',   desc: 'Toggle inline diff blocks',      category: 'view' },
  { name: 'plan',   desc: 'Plan a task or toggle plan mode', category: 'view', usage: '/plan [<task> | on | off]' },
  { name: 'mode',   desc: 'Switch mode: agent / chat / orchestrate', category: 'view', usage: '/mode <agent|chat|orchestrate>' },
  { name: 'orchestrate', desc: 'Run a request through the Plan→Scan→Refine→Build→Accept→Finalize pipeline', category: 'view', usage: '/orchestrate <request>', aliases: ['pipeline', 'orch'] },
  { name: 'pet',    desc: 'Toggle liliMiMO mascot',         category: 'view' },
  { name: 'clear',  desc: 'Clear the chat stream',          category: 'view', aliases: ['cls'] },
  { name: 'verbose', desc: 'Toggle verbose mode',           category: 'view', aliases: ['v'] },
  // system
  { name: 'permission', desc: 'Set permission mode: read-only | auto-edit | full-auto', category: 'system', usage: '/permission <mode>', aliases: ['approval', 'appr', 'perm'] },
  { name: 'run',    desc: 'Run a shell command (asks first)', category: 'system', usage: '/run <cmd>' },
  { name: 'mcp',    desc: 'Show MCP server status',         category: 'system' },
  { name: 'status', desc: 'Show session status',            category: 'system' },
  { name: 'tools',  desc: 'List available tools',           category: 'system' },
  { name: 'model',  desc: 'Show the active model',          category: 'system' },
  { name: 'skill',  desc: 'Run built-in skills',             category: 'system', usage: '/skill [list|info <name>|run <name>|<name>]' },
  { name: 'learn',  desc: 'Create project-local learned skills', category: 'system', usage: '/learn [--name <skill-name>|preview|apply|reject|status]' },
  { name: 'config', desc: 'View configuration',             category: 'system', aliases: ['cfg'] },
  { name: 'init',   desc: 'Initialize .minimum/config.json for this project', category: 'system' },
  { name: 'help',   desc: 'Show keys & commands',           category: 'system', aliases: ['?'] },
];

const NAME_INDEX = new Map<string, TuiCommand>();
for (const c of COMMANDS) {
  NAME_INDEX.set(c.name, c);
  for (const a of c.aliases ?? []) NAME_INDEX.set(a, c);
}

// ── Fuzzy matching ────────────────────────────────────────────────────

function fuzzyMatch(text: string, query: string): { score: number; positions: number[] } | null {
  if (!query) return { score: 0, positions: [] };
  const t = text.toLowerCase();
  const q = query.toLowerCase();

  if (t === q) return { score: 100, positions: Array.from({ length: t.length }, (_, i) => i) };
  if (t.startsWith(q)) return { score: 90, positions: Array.from({ length: q.length }, (_, i) => i) };

  const ci = t.indexOf(q);
  if (ci >= 0) return { score: 70, positions: Array.from({ length: q.length }, (_, i) => ci + i) };

  // subsequence
  const positions: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) { positions.push(ti); qi++; }
  }
  return qi === q.length ? { score: 40 + q.length, positions } : null;
}

export interface CmdMatch {
  cmd: TuiCommand;
  nameMatches: number[];
  descMatches: number[];
}

export interface FileMatch {
  file: FileEntry;
  nameMatches: number[];
}

/** Fuzzy filter for the command palette. Empty query → all commands. */
export function filterCommands(query: string): CmdMatch[] {
  const q = query.replace(/^\//, '').trim().toLowerCase();
  if (!q) return COMMANDS.map(cmd => ({ cmd, nameMatches: [], descMatches: [] }));

  const results: Array<{ match: CmdMatch; score: number }> = [];
  for (const cmd of COMMANDS) {
    const nm = fuzzyMatch(cmd.name, q);
    if (nm) {
      results.push({ match: { cmd, nameMatches: nm.positions, descMatches: [] }, score: nm.score });
      continue;
    }
    // try aliases
    let aliasScore = 0;
    for (const a of cmd.aliases ?? []) {
      const am = fuzzyMatch(a, q);
      if (am && am.score > aliasScore) aliasScore = am.score;
    }
    if (aliasScore > 0) {
      results.push({ match: { cmd, nameMatches: [], descMatches: [] }, score: aliasScore - 5 });
      continue;
    }
    // fall back to description
    const dm = fuzzyMatch(cmd.desc, q);
    if (dm) {
      results.push({ match: { cmd, nameMatches: [], descMatches: dm.positions }, score: dm.score - 20 });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.map(r => r.match);
}

/** Fuzzy filter for the file picker. Prioritises basename over full path. */
export function filterFiles(files: FileEntry[], query: string): FileMatch[] {
  if (!query) return files.map(file => ({ file, nameMatches: [] }));
  const q = query.toLowerCase();
  const results: Array<{ match: FileMatch; score: number }> = [];

  for (const file of files) {
    const slashIdx = file.name.lastIndexOf('/');
    const baseName = slashIdx >= 0 ? file.name.slice(slashIdx + 1) : file.name;
    const offset = slashIdx + 1; // 0 when no slash

    const bm = fuzzyMatch(baseName.toLowerCase(), q);
    if (bm) {
      results.push({
        match: { file, nameMatches: bm.positions.map(p => p + offset) },
        score: bm.score + 10,
      });
      continue;
    }
    const fm = fuzzyMatch(file.name.toLowerCase(), q);
    if (fm) {
      results.push({ match: { file, nameMatches: fm.positions }, score: fm.score });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.map(r => r.match);
}

export type CommandOutcome =
  | { kind: 'patch'; patch: Partial<AppState>; note?: string; tone?: 'info' | 'warn' | 'ok' }
  | { kind: 'help' }
  | { kind: 'quit' }
  | { kind: 'permission'; perm: Permission }
  | { kind: 'note'; note: string; tone?: 'info' | 'warn' | 'ok' }
  | { kind: 'pipeline'; text: string }
  | { kind: 'event'; event: import('./state/events.js').AgentEvent }
  | { kind: 'copy'; text: string }
  | { kind: 'session.new' }
  | { kind: 'session.save'; name?: string }
  | { kind: 'session.list' }
  | { kind: 'session.load.request'; name: string }
  | { kind: 'plan.start'; task: string }
  | { kind: 'learn.create'; preferredName?: string; dryRun?: boolean }
  | { kind: 'learn.preview'; draftId: string }
  | { kind: 'learn.apply'; draftId: string; load?: boolean; confirmRouting?: boolean }
  | { kind: 'learn.reject'; draftId: string }
  | { kind: 'learn.status' };

export type LearnCommandMode = 'create' | 'preview' | 'apply' | 'reject' | 'status';

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
      return { kind: 'session.new' };

    case 'mode': {
      const MODES = ['agent', 'chat', 'orchestrate'] as const;
      type M = typeof MODES[number];
      const target: M = (MODES as readonly string[]).includes(args[0] ?? '')
        ? (args[0] as M)
        : MODES[(MODES.indexOf(state.mode as M) + 1) % MODES.length]!;
      return { kind: 'patch', patch: { mode: target }, note: `Mode → ${target}.`, tone: 'ok' };
    }

    case 'orchestrate': {
      const request = args.join(' ').trim();
      if (!request) {
        return { kind: 'note', note: 'Usage: /orchestrate <request>', tone: 'warn' };
      }
      return { kind: 'pipeline', text: request };
    }

    case 'pet':
      return { kind: 'event', event: { type: 'pet.toggle' } };

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
      if (!hasDiff) return { kind: 'note', note: 'No diffs in this session yet.' };
      return { kind: 'event', event: { type: 'diff.toggle' } };
    }

    case 'plan': {
      const sub = args[0]?.toLowerCase();
      if (sub === 'on') {
        return { kind: 'event', event: { type: 'planmode.set', enabled: true } };
      }
      if (sub === 'off') {
        return { kind: 'event', event: { type: 'planmode.set', enabled: false } };
      }
      const task = args.join(' ').trim();
      if (task) {
        return { kind: 'plan.start', task };
      }
      // No args — show current plan status + planMode state.
      const done = state.plan.steps.filter(s => s.status === 'done').length;
      const planInfo = state.plan.steps.length
        ? `Plan "${state.plan.title}" — ${done}/${state.plan.steps.length} steps done.`
        : 'No active plan.';
      const modeInfo = state.planMode
        ? 'Plan mode: ON (mutating tools blocked). Use /plan off to disable.'
        : 'Plan mode: off. Use /plan <task> to plan, or /plan on to enable.';
      return { kind: 'note', note: `${planInfo}  ${modeInfo}` };
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

    case 'permission': {
      const MODES: ApprovalMode[] = ['read-only', 'auto-edit', 'full-auto'];
      const current = state.approvalMode;
      const target = (args[0] as ApprovalMode | undefined) ??
        MODES[(MODES.indexOf(current) + 1) % MODES.length]!;
      if (!MODES.includes(target)) {
        return { kind: 'note', note: `Unknown permission mode "${target}". Valid: ${MODES.join(' | ')}`, tone: 'warn' };
      }
      const labels: Record<ApprovalMode, string> = {
        'read-only': 'read-only — writes blocked',
        'auto-edit': 'auto-edit — file writes allowed, shell needs confirmation',
        'full-auto': 'full-auto — unrestricted',
      };
      return { kind: 'patch', patch: { approvalMode: target }, note: `Permission mode → ${labels[target]}.`, tone: 'ok' };
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
        `permission: ${state.approvalMode}`,
      ].filter(Boolean).join(' · ');
      return { kind: 'note', note: `Config — ${lines}` };
    }

    case 'skill': {
      const learned = loadLearnedSkillsSync(state.path);
      const catalog = [
        ...SKILL_CATALOG,
        ...learned.map(s => ({
          name: s.name,
          description: s.description,
          tags: s.tags,
          prompt: s.prompt,
        })),
      ];
      const sub = parts[1]?.toLowerCase();
      if (!sub || sub === 'list') {
        const lines = catalog.map(s => `  ${s.name.padEnd(18)} ${s.description}`);
        return { kind: 'note', note: `Available skills (${catalog.length}):\n${lines.join('\n')}\n\nUsage: /skill run <name>` };
      }
      if (sub === 'info') {
        const skillName = parts[2]?.toLowerCase();
        const skill = catalog.find(s => s.name === skillName);
        if (!skill) {
          const names = catalog.map(s => s.name).join(', ');
          return { kind: 'note', note: `Unknown skill: "${skillName}". Available: ${names}`, tone: 'warn' };
        }
        return { kind: 'note', note: `Skill: ${skill.name}\n${skill.description}\nTags: ${skill.tags.join(', ')}` };
      }
      // `/skill run <name>` or `/skill <name>` shorthand
      const runName = (sub === 'run' ? parts[2] : sub)?.toLowerCase();
      const skill = catalog.find(s => s.name === runName);
      if (!skill) {
        const names = catalog.map(s => s.name).join(', ');
        return { kind: 'note', note: `Unknown skill: "${runName}". Available: ${names}`, tone: 'warn' };
      }
      return { kind: 'pipeline', text: skill.prompt };
    }

    case 'learn': {
      const sub = args[0]?.toLowerCase();
      if (!sub || sub === '--name' || sub === '--dry-run') {
        const nameIdx = args.indexOf('--name');
        const preferredName = nameIdx >= 0 ? args[nameIdx + 1] : undefined;
        return { kind: 'learn.create', ...(preferredName && { preferredName }), dryRun: args.includes('--dry-run') };
      }
      if (sub === 'preview') {
        const draftId = args[1];
        return draftId ? { kind: 'learn.preview', draftId } : { kind: 'note', note: 'Usage: /learn preview <draft-id>', tone: 'warn' };
      }
      if (sub === 'apply') {
        const draftId = args[1];
        return draftId
          ? { kind: 'learn.apply', draftId, load: args.includes('--load'), confirmRouting: args.includes('--confirm-routing') }
          : { kind: 'note', note: 'Usage: /learn apply <draft-id> [--load] [--confirm-routing]', tone: 'warn' };
      }
      if (sub === 'reject') {
        const draftId = args[1];
        return draftId ? { kind: 'learn.reject', draftId } : { kind: 'note', note: 'Usage: /learn reject <draft-id>', tone: 'warn' };
      }
      if (sub === 'status') return { kind: 'learn.status' };
      return { kind: 'note', note: 'Usage: /learn [--name <skill-name>|--dry-run|preview|apply|reject|status]\n       /learn apply <draft-id> [--load] [--confirm-routing]', tone: 'warn' };
    }

    case 'sessions':
      return { kind: 'session.list' };

    case 'copy': {
      const lastMsg = [...state.messages].reverse().find(m => m.type === 'assistant');
      if (!lastMsg || lastMsg.type !== 'assistant') {
        return { kind: 'note', note: 'No assistant reply to copy.', tone: 'warn' };
      }
      return { kind: 'copy', text: lastMsg.text };
    }

    case 'verbose':
      return { kind: 'event', event: { type: 'verbose.toggle' } };

    case 'mcp': {
      if (state.mcpLoading) {
        return { kind: 'note', note: `MCP: loading ${state.mcpLoading.ready}/${state.mcpLoading.total} servers` };
      }
      const servers = ctx.mcpServers ?? [];
      if (servers.length) {
        return {
          kind: 'note',
          note: `MCP: ${servers.length} server(s) connected — ${servers.join(', ')} (${ctx.mcpToolCount ?? 0} tools)`,
        };
      }
      return { kind: 'note', note: 'MCP: no servers configured. Add `mcpServers` to .minimum/config.json' };
    }

    case 'init':
      return { kind: 'event', event: { type: 'init.run', cwd: state.path, args } };

    case 'save':
      return { kind: 'session.save', name: args[0] };

    case 'load':
      return args[0]
        ? { kind: 'session.load.request', name: args[0] }
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
