import type { AppState, Message, PipelinePhase, Toast, ToolKind } from '../types.js';
import type { AgentEvent } from './events.js';

const TOOL_KIND: Record<string, ToolKind> = {
  read_file: 'read', read: 'read', list_directory: 'read',
  git_status: 'read', git_diff: 'read', git_log: 'read',
  write_file: 'edit', edit_file: 'edit', edit: 'edit', apply_patch: 'edit',
  exec_shell: 'run', run: 'run', git: 'run',
  grep: 'find', glob: 'find', find: 'find', search: 'find', web_fetch: 'find',
};

let seq = 0;
const mid = (p: string) => p + Date.now() + '_' + seq++;
let toastSeq = 0;

function pushMessage(state: AppState, msg: Message): AppState {
  return { ...state, messages: [...state.messages, msg] };
}

function dismissExpiredToasts(toasts: Toast[]): Toast[] {
  const now = Date.now();
  return toasts.filter(t => now - t.bornAt < t.ttlMs);
}

/**
 * Pure reducer: (state, event) → next state.
 * Every TUI mutation flows through here.
 */
export function reduce(state: AppState, event: AgentEvent): AppState {
  switch (event.type) {
    // ── conversation ──────────────────────────────────────────────
    case 'user.submit':
      return pushMessage(state, {
        id: mid('u'), type: 'user', text: event.text,
      });

    case 'assistant.chunk':
      return {
        ...state,
        streaming: (state.streaming ?? '') + event.text,
      };

    case 'assistant.final': {
      const text = event.text || state.streaming || '';
      const next: AppState = { ...state, streaming: null };
      if (!text) return next;
      return pushMessage(next, {
        id: mid('a'), type: 'assistant', text,
      });
    }

    case 'tool.start':
      return {
        ...pushMessage(state, {
          id: event.id, type: 'tool',
          tool: { kind: TOOL_KIND[event.name] ?? 'read', args: event.args },
        }),
        activeTool: {
          id: event.id,
          name: event.name,
          args: event.args,
          startedAt: Date.now(),
          status: 'running',
        },
      };

    case 'tool.output':
      return {
        ...state,
        messages: state.messages.map(m =>
          m.id === event.id && m.type === 'tool'
            ? { ...m, tool: { ...m.tool, meta: event.text.slice(0, 80) } }
            : m
        ),
      };

    case 'tool.end':
      return {
        ...state,
        messages: state.messages.map(m =>
          m.id === event.id && m.type === 'tool'
            ? { ...m, tool: { ...m.tool, status: event.ok ? 'ok' : 'err', meta: event.meta ?? m.tool.meta, output: event.output ?? m.tool.output } }
            : m
        ),
        activeTool: state.activeTool?.id === event.id
          ? { ...state.activeTool, status: event.ok ? 'ok' : 'err', meta: event.meta }
          : state.activeTool,
      };

    case 'reasoning.chunk':
      return { ...state, reasoning: (state.reasoning ?? '') + event.text };

    case 'reasoning.clear':
      return { ...state, reasoning: null };

    case 'turnmeta.push':
      return pushMessage(state, {
        id: mid('tm'), type: 'turnmeta', summary: event.summary,
      });

    case 'system.push':
      return pushMessage(state, {
        id: mid('s'), type: 'system', text: event.text, tone: event.tone,
      });

    case 'error.push':
      return pushMessage(state, {
        id: mid('e'), type: 'error',
        error: { title: event.title, lines: event.lines, context: event.context, hint: event.hint },
      });

    case 'diff.push':
      return pushMessage(state, {
        id: mid('d'), type: 'diff',
        diff: { file: event.file, added: event.added, removed: event.removed, lines: event.lines },
      });

    case 'chips.push':
      return pushMessage(state, {
        id: mid('c'), type: 'chips', chips: event.chips,
      });

    case 'permission.show':
      return {
        ...pushMessage(state, {
          id: mid('p'), type: 'permission', perm: event.perm,
        }),
        pending: 'permission',
      };

    // ── session ───────────────────────────────────────────────────
    case 'session.clear':
      return {
        ...state,
        messages: [],
        committedCount: 0,
        edits: [],
        plan: { title: '(no plan yet)', steps: [] },
        currentStepLabel: '',
        streaming: null,
        reasoning: null,
        pending: null,
        activeTool: null,
      };

    case 'session.reset':
      return {
        ...state,
        messages: [],
        committedCount: 0,
        edits: [],
        plan: { title: '(no plan yet)', steps: [] },
        currentStepLabel: '',
        streaming: null,
        reasoning: null,
        pending: null,
        activeTool: null,
        ctx: { used: 0, max: state.ctx.max },
        usage: { promptTokens: 0, completionTokens: 0, sessionCost: 0, lastTurnCost: 0, cacheHit: 0 },
      };

    case 'messages.clear':
      return { ...state, messages: [], committedCount: 0 };

    case 'messages.commit':
      return { ...state, committedCount: state.messages.length };

    case 'session.load':
      return {
        ...state,
        sessionName: event.name,
        messages: [],
        committedCount: 0,
        streaming: null,
        reasoning: null,
        pending: null,
      };

    // ── UI state ──────────────────────────────────────────────────
    case 'input.change':
      return { ...state, input: event.value };

    case 'input.submit':
      return { ...state, input: '' };

    case 'approval.change':
      return { ...state, approvalMode: event.mode };

    case 'mode.change':
      return { ...state, mode: event.mode };

    case 'ctx.update':
      return {
        ...state,
        ctx: { used: event.used, max: event.max ?? state.ctx.max },
      };

    // ── plan ──────────────────────────────────────────────────────
    case 'plan.set': {
      const nowIdx = event.steps.findIndex(s => s.status === 'now');
      return {
        ...state,
        plan: { title: event.title, steps: event.steps },
        currentStepLabel: event.steps.length && nowIdx >= 0
          ? `STEP ${nowIdx + 1} · ${event.steps[nowIdx]!.label}`.toUpperCase()
          : '',
      };
    }

    case 'plan.step.update': {
      const steps = state.plan.steps.map((s, i) =>
        i === event.index ? { ...s, status: event.status } : s
      );
      const nowIdx = steps.findIndex(s => s.status === 'now');
      return {
        ...state,
        plan: { ...state.plan, steps },
        currentStepLabel: nowIdx >= 0
          ? `STEP ${nowIdx + 1} · ${steps[nowIdx]!.label}`.toUpperCase()
          : '',
      };
    }

    // ── files / edits ─────────────────────────────────────────────
    case 'files.set':
      return { ...state, files: event.files };

    case 'edit.add':
      return { ...state, edits: [...state.edits, event.edit] };

    case 'edit.remove':
      return {
        ...state,
        edits: state.edits.filter((_, i) => i !== event.index),
      };

    case 'edits.clear':
      return { ...state, edits: [] };

    // ── pending / overlay ─────────────────────────────────────────
    case 'pending.set':
      return { ...state, pending: event.value };

    case 'pending.clear':
      return { ...state, pending: null };

    case 'help.toggle':
      return { ...state, helpOpen: !state.helpOpen };

    // ── turn lifecycle ────────────────────────────────────────────
    case 'turn.start':
      return { ...state, turnInProgress: true, streaming: '', reasoning: null };

    case 'turn.end':
      return {
        ...state,
        turnInProgress: false,
        streaming: null,
        reasoning: null,
        activeTool: null,
      };

    // ── toast notifications ───────────────────────────────────────
    case 'toast.show': {
      const toast: Toast = {
        id: 'toast-' + (++toastSeq),
        text: event.text,
        tone: event.tone,
        bornAt: Date.now(),
        ttlMs: event.ttlMs ?? 4000,
      };
      return { ...state, toasts: [...dismissExpiredToasts(state.toasts), toast] };
    }

    case 'toast.dismiss':
      return { ...state, toasts: state.toasts.filter(t => t.id !== event.id) };

    // ── usage / cost ──────────────────────────────────────────────
    case 'usage.update':
      return {
        ...state,
        usage: {
          promptTokens: event.promptTokens ?? state.usage.promptTokens,
          completionTokens: event.completionTokens ?? state.usage.completionTokens,
          sessionCost: event.cost != null ? state.usage.sessionCost + event.cost : state.usage.sessionCost,
          lastTurnCost: event.cost ?? state.usage.lastTurnCost,
          cacheHit: state.usage.cacheHit, // updated separately if needed
        },
      };

    // ── edit mode ─────────────────────────────────────────────────
    case 'edit.mode.change':
      return { ...state, editMode: event.mode };

    case 'edit.undo': {
      if (!state.edits.length) return state;
      return {
        ...state,
        edits: state.edits.slice(0, -1),
        toasts: [...dismissExpiredToasts(state.toasts), {
          id: 'toast-' + (++toastSeq),
          text: `Undid: ${state.edits[state.edits.length - 1]!.label}`,
          tone: 'ok',
          bornAt: Date.now(),
          ttlMs: 3000,
        }],
      };
    }

    // ── mcp ───────────────────────────────────────────────────────
    case 'mcp.loading':
      return {
        ...state,
        mcpLoading: event.total > 0 ? { ready: event.ready, total: event.total } : null,
      };

    // ── verbose ───────────────────────────────────────────────────
    case 'verbose.toggle':
      return { ...state, verbose: !state.verbose };

    // ── pipeline (orchestrator) ──────────────────────────────────
    case 'pipeline.start':
      return { ...state, pipeline: [] };

    case 'pipeline.phase': {
      // Mark every prior phase done (record endedAt); activate the incoming one.
      const now = Date.now();
      const prior: PipelinePhase[] = (state.pipeline ?? []).map(p => ({
        ...p,
        status: 'done' as const,
        endedAt: p.status === 'active' ? now : p.endedAt,
      }));
      const existing = prior.findIndex(p => p.phase === event.phase);
      const newPhase: PipelinePhase = {
        phase: event.phase, label: event.label, status: 'active',
        startedAt: now, detail: event.detail,
      };
      if (existing >= 0) {
        prior[existing] = newPhase;
        return { ...state, pipeline: prior };
      }
      return { ...state, pipeline: [...prior, newPhase] };
    }

    case 'pipeline.end': {
      const now = Date.now();
      const done = (state.pipeline ?? []).map(p => ({
        ...p,
        status: 'done' as const,
        endedAt: p.status === 'active' ? now : p.endedAt,
      }));
      return { ...state, pipeline: done.length ? done : null };
    }

    // ── init ─────────────────────────────────────────────────────
    case 'init.run':
      return state; // no-op in reducer; async work happens in app layer
  }
}
