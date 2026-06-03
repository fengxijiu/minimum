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

/**
 * Length of the longest contiguous prefix of `messages` that is "settled"
 * (safe to freeze into the <Static> scrollback). A message is settled
 * unless it's a tool whose tool.end hasn't fired yet (status undefined) —
 * such a row still mutates by id and must stay in the live region.
 */
function settledPrefix(messages: Message[], from: number): number {
  let n = Math.max(0, from);
  while (n < messages.length) {
    const m = messages[n]!;
    if (m.type === 'tool' && m.tool.status === undefined) break;
    n++;
  }
  return n;
}

function pushMessage(state: AppState, msg: Message): AppState {
  const messages = [...state.messages, msg];
  // Advance the committed prefix synchronously on every push. This freezes
  // settled messages straight into <Static> so a tall one (a pasted prompt,
  // a long reply, a big error/diff) never lands in the repainting region —
  // not even for a single frame — which would otherwise trip Ink's
  // clearTerminal (flicker + scrollback wipe via \x1b[3J). Grouping survives
  // because ChatStream partitions render items by their last message index.
  return { ...state, messages, committedCount: settledPrefix(messages, state.committedCount) };
}

function samePlanSteps(a: AppState['plan']['steps'], b: AppState['plan']['steps']): boolean {
  return a.length === b.length && a.every((step, index) => {
    const other = b[index];
    return other?.label === step.label && other.status === step.status;
  });
}

function sameFiles(a: AppState['files'], b: AppState['files']): boolean {
  return a.length === b.length && a.every((file, index) => {
    const other = b[index];
    return other?.name === file.name && other.meta === file.meta && other.staged === file.staged;
  });
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
      if (!event.text) return state;
      return {
        ...state,
        streaming: (state.streaming ?? '') + event.text,
      };

    case 'assistant.final': {
      const text = event.text || state.streaming || '';
      if (!text && state.streaming === null) return state;
      const next: AppState = { ...state, streaming: null };
      if (!text) return next;
      // pushMessage commits the settled prefix, so the finished reply is
      // frozen straight into <Static> instead of landing tall in the live
      // region for a frame (which would trip clearTerminal).
      return pushMessage(next, { id: mid('a'), type: 'assistant', text });
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

    case 'tool.output': {
      let changed = false;
      const meta = event.text.slice(0, 80);
      const messages = state.messages.map(m => {
        if (m.id !== event.id || m.type !== 'tool' || m.tool.meta === meta) return m;
        changed = true;
        return { ...m, tool: { ...m.tool, meta } };
      });
      return changed ? { ...state, messages } : state;
    }

    case 'tool.end': {
      let changed = false;
      const status: 'ok' | 'err' = event.ok ? 'ok' : 'err';
      const messages = state.messages.map(m => {
        if (m.id !== event.id || m.type !== 'tool') return m;
        changed = true;
        return { ...m, tool: { ...m.tool, status: (event.ok ? 'ok' : 'err') as 'ok' | 'err', meta: event.meta ?? m.tool.meta, output: event.output ?? m.tool.output } };
      });
      const activeMatches = state.activeTool?.id === event.id;
      if (!changed && !activeMatches) return state;
      return {
        ...state,
        messages,
        activeTool: activeMatches
          ? { ...state.activeTool!, status, meta: event.meta }
          : state.activeTool,
        // Advance the settled prefix now that this tool's status is set.
        committedCount: settledPrefix(messages, state.committedCount),
      };
    }

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

    case 'diff.toggle': {
      const messages = state.messages.map(m =>
        m.type === 'diff' ? { ...m, diff: { ...m.diff, collapsed: !m.diff.collapsed } } : m
      );
      return messages === state.messages ? state : { ...state, messages };
    }

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
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          sessionCost: 0,
          lastTurnCost: 0,
          cacheHit: 0,
          currency: state.usage.currency,
        },
      };

    case 'messages.clear':
      return { ...state, messages: [], committedCount: 0 };

    case 'messages.commit': {
      // Commit a contiguous prefix into the <Static> scrollback layer.
      // `count` lets callers commit only the settled prefix mid-turn; it
      // defaults to the full list (end-of-turn commit). Never moves backward.
      const next = Math.min(event.count ?? state.messages.length, state.messages.length);
      if (next <= state.committedCount) return state;
      return { ...state, committedCount: next };
    }

    case 'session.restore':
      return {
        ...state,
        sessionName: event.sessionName,
        messages: event.messages,
        committedCount: event.messages.length,
        streaming: null,
        reasoning: null,
        pending: null,
        activeTool: null,
        edits: [],
        plan: { title: '(no plan yet)', steps: [] },
        currentStepLabel: '',
      };

    // ── UI state ──────────────────────────────────────────────────
    case 'input.change':
      return { ...state, input: event.value };

    case 'input.submit':
      return { ...state, input: '' };

    case 'approval.change':
      return state.approvalMode === event.mode ? state : { ...state, approvalMode: event.mode };

    case 'mode.change':
      return state.mode === event.mode ? state : { ...state, mode: event.mode };

    case 'ctx.update': {
      const nextMax = event.max ?? state.ctx.max;
      if (state.ctx.used === event.used && state.ctx.max === nextMax) return state;
      return {
        ...state,
        ctx: { used: event.used, max: nextMax },
      };
    }

    case 'pet.toggle':
      return { ...state, petVisible: !state.petVisible };

    // ── plan ──────────────────────────────────────────────────────
    case 'plan.set': {
      const nowIdx = event.steps.findIndex(s => s.status === 'now');
      const currentStepLabel = event.steps.length && nowIdx >= 0
        ? `STEP ${nowIdx + 1} · ${event.steps[nowIdx]!.label}`.toUpperCase()
        : '';
      if (
        state.plan.title === event.title
        && samePlanSteps(state.plan.steps, event.steps)
        && state.currentStepLabel === currentStepLabel
      ) return state;
      return {
        ...state,
        plan: { title: event.title, steps: event.steps },
        currentStepLabel,
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
      return sameFiles(state.files, event.files) ? state : { ...state, files: event.files };

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
      return state.pending === null ? state : { ...state, pending: null };

    case 'help.toggle':
      return { ...state, helpOpen: !state.helpOpen };

    // ── turn lifecycle ────────────────────────────────────────────
    case 'turn.start':
      return { ...state, turnInProgress: true, streaming: '', reasoning: null };

    case 'turn.end':
      if (!state.turnInProgress && state.streaming === null && state.reasoning === null && state.activeTool === null) return state;
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

    case 'toast.dismiss': {
      const toasts = state.toasts.filter(t => t.id !== event.id);
      return toasts.length === state.toasts.length ? state : { ...state, toasts };
    }

    // ── usage / cost ──────────────────────────────────────────────
    case 'usage.update': {
      const promptTokens = event.promptTokens ?? state.usage.promptTokens;
      const cachedTokens = event.cachedTokens ?? state.usage.cachedTokens;
      // Cache-hit ratio is derived rather than transported — promptTokens
      // already includes the cached portion, so the ratio comes from the
      // same authoritative numbers the rest of the UI shows.
      const cacheHit = promptTokens > 0
        ? Math.min(1, Math.max(0, cachedTokens / promptTokens))
        : 0;
      return {
        ...state,
        usage: {
          promptTokens,
          completionTokens: event.completionTokens ?? state.usage.completionTokens,
          cachedTokens,
          sessionCost: event.cost != null ? state.usage.sessionCost + event.cost : state.usage.sessionCost,
          lastTurnCost: event.cost ?? state.usage.lastTurnCost,
          cacheHit,
          currency: event.currency ?? state.usage.currency,
        },
      };
    }

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

    // ── plan mode ─────────────────────────────────────────────────
    case 'planmode.set':
      return state.planMode === event.enabled ? state : { ...state, planMode: event.enabled };

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
      // Drop running subagents — pipeline ended, anything still "running" is
      // stale. Keep terminal entries so the user sees the final tally briefly.
      const remainingSubagents = state.subagents.filter(s => s.status !== 'running');
      return {
        ...state,
        pipeline: done.length ? done : null,
        subagents: remainingSubagents,
      };
    }

    // ── subagent brief ────────────────────────────────────────────
    case 'subagent.update': {
      const now = Date.now();
      const existing = state.subagents.find(s => s.taskId === event.taskId);
      const startedAt = existing?.startedAt ?? now;
      const updated = {
        taskId: event.taskId,
        personaId: event.personaId,
        objective: event.objective,
        step: event.step,
        maxSteps: event.maxSteps,
        toolCalls: event.toolCalls,
        ...(event.lastTool !== undefined && { lastTool: event.lastTool }),
        ...(event.lastToolArgs !== undefined && { lastToolArgs: event.lastToolArgs }),
        tokens: event.tokens,
        cost: event.cost,
        currency: event.currency,
        status: event.status,
        startedAt,
        updatedAt: now,
      };
      // Preserve startedAt ordering; replace-in-place if known, append otherwise.
      const subagents = existing
        ? state.subagents.map(s => (s.taskId === event.taskId ? updated : s))
        : [...state.subagents, updated];
      return { ...state, subagents };
    }

    case 'subagent.clear':
      if (event.taskId) {
        const next = state.subagents.filter(s => s.taskId !== event.taskId);
        return next.length === state.subagents.length ? state : { ...state, subagents: next };
      }
      return state.subagents.length === 0 ? state : { ...state, subagents: [] };

    // ── init ─────────────────────────────────────────────────────
    case 'init.run':
      return state; // no-op in reducer; async work happens in app layer
  }
}
