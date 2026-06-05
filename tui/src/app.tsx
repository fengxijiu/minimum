import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Box, useApp } from 'ink';
import { TitleBar }       from './components/TitleBar.js';
import { PlanStrip }      from './components/PlanStrip.js';
import { PipelinePanel }  from './components/PipelinePanel.js';
import { SubagentBrief }  from './components/SubagentBrief.js';
import { ChatStream }     from './components/ChatStream.js';
import { StatusBar }      from './components/StatusBar.js';
import { WelcomeScreen }  from './components/WelcomeScreen.js';
import { ToastBar }       from './components/ToastBar.js';
import { InputArea }      from './components/InputArea.js';
import { createInitialState } from './seed.js';
import {
  runCommand, type CommandOutcome, type CommandContext,
} from './commands.js';
import { LearnCommandService } from '../../dist/learn/LearnCommandService.js';
import { PlanCommandService } from '../../dist/plans/PlanCommandService.js';
import { loadLearnedSkillsSync } from '../../dist/skills/LearnedSkillLoader.js';
import { mockRunner, uiEventToMessages, summarizeTool, summarizeToolResult, describePermissionArgs, buildErrorLines, PermissionQueue, type Runner, type EngineInfo, type McpOverviewInfo, type UiEvent, type UiPlanStatus, type TuiConfirmationGate } from './engine.js';
import { scanFiles, readBranch, touch } from './files.js';
import { getContextUsageK } from './context-usage.js';
import {
  saveTuiSession, loadTuiSessionById, listTuiSessions, formatSessionList,
  type TuiSession,
} from './session.js';
import { useAgentStore, useSlice, type Dispatch } from './state/store.js';
import type { AppState, Message, FileEntry, SessionState, PlanStep, PendingState, ApprovalMode, UsageInfo, Mode, StagedEdit, ChoiceRequest } from './types.js';

const PLAN_STATUS: Record<UiPlanStatus, PlanStep['status']> = {
  pending: 'next',
  in_progress: 'now',
  completed: 'done',
};

interface ActivePermission {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  risk: 'low' | 'medium' | 'high';
  description: string;
}

let seq = 0;
const tid = () => 't' + Date.now() + '_' + seq++;

function extractFileArg(args: string): string | null {
  try {
    const obj = JSON.parse(args.replace(/^\S+\s/, ''));
    const v = obj?.path ?? obj?.file ?? obj?.file_path ?? obj?.filepath;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

const DEFAULT_ENGINE_INFO: EngineInfo = { mode: 'mock', reason: 'not-built' };

function formatPlanDraftSummary(draft: { id: string; title: string; status: string; steps: Array<{ label: string; status: string }> }): string {
  const active = draft.steps.find(step => step.status === 'now');
  return [
    `[${draft.status}] ${draft.title}`,
    `  id: ${draft.id}`,
    `  steps: ${draft.steps.length}${active ? ` • active: ${active.label}` : ''}`,
  ].join('\n');
}

function formatMcpOverview(overview: McpOverviewInfo): string {
  const lines = [
    `MCP: ${overview.connected.length} connected, ${overview.failed.length} failed`,
    `Totals: ${overview.totalTools} tools • ${overview.totalResources} resources • ${overview.totalPrompts} prompts`,
  ];
  if (overview.connected.length > 0) {
    lines.push('', 'Connected:');
    for (const server of overview.connected) {
      lines.push(
        `  ${server.name} (${server.transport}) — ${server.toolCount} tools, ${server.resourceCount} resources, ${server.promptCount} prompts`,
      );
      if (server.url) lines.push(`    url: ${server.url}`);
      if (server.allowedTools?.length) lines.push(`    allowlist: ${server.allowedTools.join(', ')}`);
      if (server.deniedTools?.length) lines.push(`    denylist: ${server.deniedTools.join(', ')}`);
      if (server.toolNames.length) lines.push(`    tools: ${server.toolNames.slice(0, 12).join(', ')}${server.toolNames.length > 12 ? ' ...' : ''}`);
      if (server.headerKeys.length) lines.push(`    headers: ${server.headerKeys.join(', ')}`);
    }
  }
  if (overview.failed.length > 0) {
    lines.push('', 'Failed:');
    for (const server of overview.failed) {
      lines.push(`  ${server.name} (${server.transport}) — ${server.error}`);
      if (server.url) lines.push(`    url: ${server.url}`);
      if (server.allowedTools?.length) lines.push(`    allowlist: ${server.allowedTools.join(', ')}`);
      if (server.deniedTools?.length) lines.push(`    denylist: ${server.deniedTools.join(', ')}`);
      if (server.headerKeys.length) lines.push(`    headers: ${server.headerKeys.join(', ')}`);
    }
  }
  if (overview.connected.length === 0 && overview.failed.length === 0) {
    lines.push('', 'No MCP servers connected. Built-in Minimum resources are still available via `/mcp resources`.');
  }
  return lines.join('\n');
}

function formatMcpResourceList(resources: Array<{ server: string; uri: string; description?: string }>): string {
  if (resources.length === 0) return 'No MCP resources available.';
  return [
    `MCP resources (${resources.length}):`,
    ...resources.map((resource) => `  [${resource.server}] ${resource.uri}${resource.description ? ` — ${resource.description}` : ''}`),
  ].join('\n');
}

function formatMcpPromptList(prompts: Array<{ server: string; name: string; description?: string }>): string {
  if (prompts.length === 0) return 'No MCP prompts available.';
  return [
    `MCP prompts (${prompts.length}):`,
    ...prompts.map((prompt) => `  [${prompt.server}] ${prompt.name}${prompt.description ? ` — ${prompt.description}` : ''}`),
  ].join('\n');
}

function formatUnknownPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function parseJsonArgs(argsText: string | undefined): Record<string, unknown> | undefined {
  if (!argsText) return undefined;
  const parsed = JSON.parse(argsText) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('prompt args must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

// ── Loop-guard tunables ───────────────────────────────────────────────
/** Abort turn when the same tool+args fires this many times in a row. */
const STORM_THRESHOLD = 3;
/**
 * Tools exempt from storm detection. These are status/polling calls the model
 * legitimately re-issues with identical args during a single turn:
 *   - todo_write / todo_read: progress-tracking state refreshes
 *   - wait_for_job: blocking poll on a background job's completion
 *   - list_jobs / job_output: incremental status/output reads on the same job id
 * Duplicates here are normal flow, not a stuck-loop signal.
 */
const STORM_EXEMPT_TOOLS = new Set([
  'todo_write',
  'todo_read',
  'wait_for_job',
  'list_jobs',
  'job_output',
]);
/** Cap on accumulated reasoning text (~2 k tokens) to keep state bounded. */
const REASONING_CHAR_CAP = 8_000;
/** Context-fill ratios at which a warning toast fires (each fires once per session). */
const CTX_WARN_THRESHOLDS = [0.75, 0.90] as const;
/** Errors whose message matches any of these strings are retried (up to 2 extra attempts). */
const RETRYABLE_PATTERNS = ['timeout', '503', '529', 'rate limit', 'rate_limit', 'overload', 'econnreset', 'network error'];

// ── Zone components — pure props, no state object ──────────────────────

/** TitleBar zone — only re-renders on path/branch/mode changes. */
const TitleZone = React.memo(function TitleZone({ path, branch, mode }: {
  path: string; branch: string; mode: string;
}) {
  return <TitleBar path={path} branch={branch} mode={mode} />;
});

/** PlanStrip zone — only re-renders on plan changes. */
const PlanZone = React.memo(function PlanZone({ title, steps }: {
  title: string; steps: PlanStep[];
}) {
  return <PlanStrip title={title} steps={steps} />;
});

/** Pipeline zone — only re-renders on pipeline phase changes. */
const PipelineZone = React.memo(function PipelineZone({ phases }: {
  phases: AppState['pipeline'];
}) {
  return <PipelinePanel phases={phases} />;
});

/** ChatStream zone — only re-renders on messages/stepLabel/activeTool/streaming changes. */
const ChatZone = React.memo(function ChatZone({
  messages, committedCount, stepLabel, activeTool,
  streaming, reasoning, verbose, petVisible, cols, maxRows, reservedRows, resizeRevision, header,
}: {
  messages: Message[]; committedCount: number;
  stepLabel: string; activeTool: AppState['activeTool'];
  streaming?: string | null; reasoning?: string | null; verbose?: boolean;
  petVisible: boolean;
  cols: number; maxRows: number; reservedRows: number; resizeRevision: number; header: React.ReactNode;
}) {
  return (
    <ChatStream
      stepLabel={stepLabel}
      messages={messages}
      committedCount={committedCount}
      streaming={streaming}
      reasoning={reasoning}
      activeTool={activeTool}
      verbose={verbose}
      petVisible={petVisible}
      cols={cols}
      maxRows={maxRows}
      reservedRows={reservedRows}
      resizeRevision={resizeRevision}
      header={header}
    />
  );
});

/** StatusBar zone — only re-renders on status/usage changes. */
const StatusZone = React.memo(function StatusZone({
  statusState, approvalMode, ctxUsed, ctxMax, hint, usage, mcpLoading,
}: {
  statusState: SessionState; approvalMode?: ApprovalMode;
  ctxUsed: number; ctxMax: number; hint: string; usage: UsageInfo; mcpLoading: AppState['mcpLoading'];
}) {
  return (
    <StatusBar
      state={statusState}
      approvalMode={approvalMode}
      ctxUsed={ctxUsed}
      ctxMax={ctxMax}
      hint={hint}
      usage={usage}
      mcpLoading={mcpLoading}
    />
  );
});

// ── Main App ──────────────────────────────────────────────────────────

export function App({
  runner = mockRunner,
  pipelineRunner,
  engineInfo = DEFAULT_ENGINE_INFO,
  choiceGate,
  initialSession,
}: { runner?: Runner; pipelineRunner?: Runner; engineInfo?: EngineInfo; choiceGate?: TuiConfirmationGate; initialSession?: TuiSession | null } = {}) {
  const { exit } = useApp();
  // ── Terminal size — width drives text wrap, height caps the live frame ─
  const [termSize, setTermSize] = useState(() => ({
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 40,
    revision: 0,
  }));
  useEffect(() => {
    const onResize = () => {
      const cols = process.stdout.columns ?? 80;
      const rows = process.stdout.rows ?? 40;
      setTermSize(prev => (
        prev.cols === cols && prev.rows === rows
          ? prev
          : { cols, rows, revision: prev.revision + 1 }
      ));
    };
    process.stdout.on('resize', onResize);
    return () => { process.stdout.off('resize', onResize); };
  }, []);

  const [state, dispatch] = useAgentStore(() => createInitialState(process.cwd()));
  const [activeChoice, setActiveChoice] = useState<ChoiceRequest | null>(null);
  // FIFO queue of permission prompts: only one is shown at a time, the rest wait
  // their turn. The runner already holds each pending approval by id, so queued
  // prompts resolve correctly once surfaced. Held in a ref so the streaming loop
  // and the resolve callbacks share one authoritative instance.
  const permQueueRef = useRef(new PermissionQueue<ActivePermission>());
  // Mutable refs so callbacks that close over these stay stable
  const stateRef = useRef(state);
  stateRef.current = state;
  // Tracks the last-started tool message id so tool_result can close it out.
  const lastToolIdRef = useRef<string | null>(null);
  // Remembers the active tool's name + display args so a failure can attribute itself.
  const lastToolDescRef = useRef<string | null>(null);
  // Per-turn storm map: "toolName\x00argsPrefix" → call count.
  const stormMapRef = useRef(new Map<string, number>());

  // ── Session persistence ──────────────────────────────────────────────
  const sessionIdRef = useRef(`auto_${Date.now()}`);
  const sessionCreatedAtRef = useRef(Date.now());

  // ── Per-turn telemetry (reset on turn.start, drained into turnmeta) ──
  const turnToolCountRef = useRef(0);
  const turnUsageRef = useRef<{
    totalTokens: number;
    toolCalls: number;
    steps: number;
    totalCost: number;
    currency: 'CNY' | 'Credits';
  } | null>(null);
  // Tracks cumulative cost at the start of the current turn to compute per-turn delta.
  const prevCostRef = useRef(0);

  // Abort controller for the in-flight turn — set on turn start, cleared on end.
  // Double Ctrl+C calls .abort() so the for-await loop in runTurn bails out.
  const turnAbortRef = useRef<AbortController | null>(null);

  // ── Streaming chunk buffer (adaptive ~120ms coalescing flush) ────────
  // Buffers both answer text and reasoning text, draining them together on an
  // adaptive cadence so high-frequency token streams don't trigger a render per
  // token. A single timer covers both streams.
  const chunkBufferRef = useRef('');
  const reasoningBufferRef = useRef('');
  const chunkFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chunkLastFlushRef = useRef(0);
  const chunkCountRef = useRef(0);
  const flushChunks = useCallback(() => {
    if (chunkFlushTimerRef.current) {
      clearTimeout(chunkFlushTimerRef.current);
      chunkFlushTimerRef.current = null;
    }
    chunkCountRef.current = 0;
    if (chunkBufferRef.current) {
      dispatch({ type: 'assistant.chunk', text: chunkBufferRef.current });
      chunkBufferRef.current = '';
    }
    if (reasoningBufferRef.current) {
      dispatch({ type: 'reasoning.chunk', text: reasoningBufferRef.current });
      reasoningBufferRef.current = '';
    }
    chunkLastFlushRef.current = Date.now();
  }, [dispatch]);
  const scheduleChunkFlush = useCallback(() => {
    if (chunkFlushTimerRef.current) return;
    const elapsed = Date.now() - chunkLastFlushRef.current;
    // Adaptive target delay: fast streams (many chunks per ms) → longer window to
    // reduce redraws; slow streams → shorter window for responsiveness.
    const rate = elapsed > 0 ? chunkCountRef.current / elapsed : 0; // chunks/ms
    const target = rate > 0.08 ? 80 : rate > 0.03 ? 40 : 20;
    const delay = Math.max(0, target - elapsed);
    chunkFlushTimerRef.current = setTimeout(flushChunks, delay);
  }, [flushChunks]);
  const startChunkFlusher = useCallback(() => {
    chunkLastFlushRef.current = Date.now();
  }, []);
  const stopChunkFlusher = useCallback(() => {
    flushChunks();
  }, [flushChunks]);

  // ── Init ────────────────────────────────────────────────────────────
  useEffect(() => {
    const root = process.cwd();
    const scanned = scanFiles(root);
    // Context window is measured in k-tokens for the TokenMeter; engineInfo
    // carries the real number (1 048 576 for mimo-v2.5*), so the % bar tracks
    // the model's actual capacity instead of the prior hardcoded 200k guess.
    const ctxMaxK = engineInfo.contextWindow
      ? Math.round(engineInfo.contextWindow / 1000)
      : 200;
    dispatch({ type: 'ctx.update', used: 0, max: ctxMaxK });
    if (scanned.length) dispatch({ type: 'files.set', files: scanned });
    if (engineInfo.mode === 'mock') {
      const reason = engineInfo.reason ?? 'not-built';
      const detail = reason === 'no-api-key'
        ? `no MIMO_API_KEY — set env or write ${engineInfo.configPath ?? '~/.minimum/config.json'}`
        : reason === 'not-built'
        ? 'engine bundle missing — run `npm run build` in the repo root'
        : `engine init failed${engineInfo.error ? ` — ${engineInfo.error}` : ''}`;
      dispatch({ type: 'system.push', text: `mock mode · ${detail}`, tone: 'warn' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Choice gate wiring ──────────────────────────────────────────────
  useEffect(() => {
    if (!choiceGate) return;
    choiceGate.onShow = (payload) => {
      setActiveChoice({ question: payload.question, options: payload.options, allowCustom: payload.allowCustom, context: payload.context });
      dispatch({ type: 'pending.set', value: 'choice' });
    };
    return () => { choiceGate.onShow = null; };
  }, [choiceGate, dispatch]);

  const cmdCtx: CommandContext = useMemo(() => ({
    model: engineInfo.model,
    tools: engineInfo.tools,
    configPath: engineInfo.configPath,
    memoryPath: engineInfo.memoryPath,
    baseUrl: engineInfo.baseUrl,
    engineMode: engineInfo.mode,
    mcpServers: engineInfo.mcpServers,
    mcpToolCount: engineInfo.mcpToolCount,
  }), [engineInfo]);
  const restoreSession = useCallback(async (session: TuiSession) => {
    sessionIdRef.current = session.id;
    sessionCreatedAtRef.current = session.createdAt;
    prevCostRef.current = 0;
    activeRunnerRef.current = runner;
    // NEW: clear both histories first so a restore never leaves stale context behind.
    runner.loadHistory?.([]);
    pipelineRunner?.loadHistory?.([]);
    if (session.engineSessionId) {
      await runner.loadSessionById?.(session.engineSessionId);
    } else {
      await runner.loadLastSession?.();
    }
    if (session.chatHistory?.length) {
      runner.loadHistory?.(session.chatHistory);
      pipelineRunner?.loadHistory?.(session.chatHistory);
    }
    dispatch({ type: 'session.restore', messages: session.messages, sessionName: session.name });
    const msgCount = session.messages.filter(m => m.type === 'user' || m.type === 'assistant').length;
    const ctxNote = session.chatHistory?.length ? ` · AI context restored (${session.chatHistory.length} turns)` : '';
    return { msgCount, ctxNote };
  }, [dispatch, pipelineRunner, runner]);
  // ── Command / permission handlers ───────────────────────────────────
  const applyOutcome = useCallback((o: CommandOutcome) => {
    switch (o.kind) {
      case 'quit': exit(); return;
      case 'help': dispatch({ type: 'help.toggle' }); return;
      case 'note': dispatch({ type: 'system.push', text: o.note, tone: o.tone }); return;
      case 'copy': {
        // OSC 52: write base64-encoded text to the terminal clipboard.
        const b64 = Buffer.from(o.text, 'utf-8').toString('base64');
        process.stdout.write(`\x1b]52;c;${b64}\x07`);
        dispatch({ type: 'toast.show', text: 'Copied last reply', tone: 'ok', ttlMs: 2000 });
        return;
      }
      case 'session.new': {
        const name = `auto_${Date.now()}`;
        sessionIdRef.current = name;
        sessionCreatedAtRef.current = Date.now();
        prevCostRef.current = 0;
        activeRunnerRef.current = runner;
        // NEW: make /new a real session boundary for both engine surfaces.
        runner.loadHistory?.([]);
        pipelineRunner?.loadHistory?.([]);
        const freshSession = runner.startNewSession?.();
        void freshSession?.catch(() => {});
        dispatch({ type: 'session.reset' });
        dispatch({ type: 'system.push', text: 'Started a fresh session.', tone: 'ok' });
        return;
      }
      case 'permission':
        dispatch({ type: 'permission.show', perm: o.perm });
        return;
      case 'event':
        if (o.event.type === 'init.run') {
          runInit(o.event.cwd, dispatch, o.event.args);
          return;
        }
        dispatch(o.event);
        return;
      case 'patch':
        if (o.patch.approvalMode) {
          runner.setApprovalMode?.(o.patch.approvalMode);
        }
        if (o.patch.messages) dispatch({ type: 'messages.clear' });
        for (const msg of o.patch.messages ?? []) {
          if (msg.type === 'system') dispatch({ type: 'system.push', text: msg.text, tone: msg.tone });
          else if (msg.type === 'assistant') dispatch({ type: 'assistant.final', text: msg.text });
          else if (msg.type === 'error') dispatch({ type: 'error.push', title: msg.error.title, lines: msg.error.lines });
          else if (msg.type === 'tool') dispatch({ type: 'tool.start', id: msg.id, name: msg.tool.kind, args: msg.tool.args });
        }
        if (o.patch.approvalMode) dispatch({ type: 'approval.change', mode: o.patch.approvalMode });
        if (o.patch.mode) dispatch({ type: 'mode.change', mode: o.patch.mode });
        if (o.note) dispatch({ type: 'system.push', text: o.note, tone: o.tone });
        return;
      case 'session.save': {
        const name = o.name?.trim() || `session_${Date.now()}`;
        const s = stateRef.current;
        sessionIdRef.current = name;
        void saveTuiSession({
          id: name,
          name,
          projectPath: s.path,
          messages: s.messages,
          chatHistory: activeRunnerRef.current.getHistory?.(),
          engineSessionId: runner.getSessionId?.() ?? undefined,
          createdAt: sessionCreatedAtRef.current,
          updatedAt: Date.now(),
        }).then(() => {
          dispatch({ type: 'system.push', text: `Session saved as "${name}".`, tone: 'ok' });
        }).catch(() => {
          dispatch({ type: 'system.push', text: 'Failed to save session.', tone: 'warn' });
        });
        return;
      }
      case 'session.list':
        void listTuiSessions().then(sessions => {
          dispatch({ type: 'system.push', text: formatSessionList(sessions) });
        }).catch(() => {
          dispatch({ type: 'system.push', text: 'Failed to list sessions.', tone: 'warn' });
        });
        return;
      case 'session.load.request': {
        const name = o.name;
        void loadTuiSessionById(name).then(session => {
          if (!session) {
            dispatch({ type: 'system.push', text: `Session "${name}" not found.`, tone: 'warn' });
            return;
          }
          // NEW: restore both the TUI snapshot and runner histories through one path.
          void restoreSession(session).then(({ msgCount, ctxNote }) => {
            dispatch({ type: 'system.push', text: `Loaded "${session.name}" (${msgCount} messages${ctxNote}).`, tone: 'ok' });
          });
          return;
        }).catch(() => {
          dispatch({ type: 'system.push', text: `Failed to load session "${name}".`, tone: 'warn' });
        });
        return;
      }
      case 'plan.drafts': {
        const service = new PlanCommandService({ projectRoot: stateRef.current.path });
        void service.status().then(result => {
          if (result.drafts.length === 0) {
            dispatch({ type: 'system.push', text: 'No task plan drafts found under `.minimum/plans/drafts`.', tone: 'info' });
            return;
          }
          dispatch({
            type: 'system.push',
            text: [
              `Task plan drafts (${result.drafts.length}):`,
              ...result.drafts.map((draft) => formatPlanDraftSummary(draft)),
            ].join('\n'),
            tone: 'info',
          });
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to list plan drafts: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
      case 'plan.preview': {
        const service = new PlanCommandService({ projectRoot: stateRef.current.path });
        void service.preview(o.draftId).then(result => {
          dispatch({ type: 'system.push', text: result.markdown, tone: result.draft.status === 'invalid' ? 'warn' : 'info' });
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to preview plan draft: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
      case 'plan.import': {
        const service = new PlanCommandService({ projectRoot: stateRef.current.path });
        void service.import(o.draftId).then(result => {
          dispatch({ type: 'plan.set', title: result.title, steps: result.steps });
          dispatch({ type: 'planmode.set', enabled: true });
          runner.setPlanMode?.(true);
          dispatch({
            type: 'system.push',
            text: `Imported plan draft: ${result.draft.id}\nPlan "${result.title}" is now loaded into the TUI plan strip.`,
            tone: 'ok',
          });
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to import plan draft: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
      case 'plan.reject': {
        const service = new PlanCommandService({ projectRoot: stateRef.current.path });
        void service.reject(o.draftId).then(result => {
          dispatch({ type: 'system.push', text: `Rejected plan draft: ${result.id}`, tone: 'ok' });
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to reject plan draft: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
      case 'learn.create': {
        const s = stateRef.current;
        const service = new LearnCommandService({
          projectRoot: s.path,
          generateWithModel: runner.completeText,
        });
        void service.create({
          preferredName: o.preferredName,
          dryRun: o.dryRun,
          messages: s.messages
            .filter((m): m is Extract<Message, { type: 'user' | 'assistant' | 'system' }> => m.type === 'user' || m.type === 'assistant' || m.type === 'system')
            .map(m => ({ role: m.type, content: m.text })),
        }).then(result => {
          const note = [
            result.dryRun ? 'Learned skill dry-run generated.' : `Learned skill draft created: ${result.draft.id}`,
            `Name: ${result.draft.name}`,
            `Target: ${result.draft.targetPath}`,
            result.validation.ok ? 'Validation: ok' : `Validation: ${result.validation.errors.join('; ')}`,
            result.dryRun ? '' : `Apply with: /learn apply ${result.draft.id} --load`,
          ].filter(Boolean).join('\n');
          dispatch({ type: 'system.push', text: note, tone: result.validation.ok ? 'ok' : 'warn' });
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to create learned skill: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
      case 'learn.preview': {
        const service = new LearnCommandService({ projectRoot: stateRef.current.path });
        void service.preview(o.draftId).then(result => {
          dispatch({ type: 'system.push', text: result.markdown });
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to preview learned skill: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
      case 'learn.apply': {
        const applyRoot = stateRef.current.path;
        const service = new LearnCommandService({
          projectRoot: applyRoot,
          reloadSkills: runner.reloadSkills,
        });
        void service.apply(o.draftId, { confirmRouting: o.confirmRouting }).then(result => {
          const assignment = result.assignments[0];
          dispatch({
            type: 'system.push',
            text: [
              `Learned skill applied: ${result.draft.name}`,
              `Wrote: ${result.skillPath}`,
              assignment ? `Persona: ${assignment.persona_id} (${assignment.stage_affinity.join(', ')}, confidence ${assignment.confidence.toFixed(2)})` : null,
              result.routingWritten
                ? 'Routing written.'
                : `Routing needs confirmation — re-run: /learn apply ${result.draft.id} --confirm-routing`,
            ].filter(Boolean).join('\n'),
            tone: result.routingWritten ? 'ok' : 'warn',
          });
          // Show all currently available learned skills so the user knows what to use
          const freshSkills = loadLearnedSkillsSync(applyRoot);
          if (freshSkills.length > 0) {
            dispatch({ type: 'system.push', text: `Skills available: ${freshSkills.map(s => `/skill run ${s.name}`).join('  ·  ')}`, tone: 'info' });
          }
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to apply learned skill: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
      case 'learn.reject': {
        const service = new LearnCommandService({ projectRoot: stateRef.current.path });
        void service.reject(o.draftId).then(result => {
          dispatch({ type: 'system.push', text: `Rejected learned skill draft: ${result.id}`, tone: 'ok' });
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to reject learned skill: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
      case 'learn.status': {
        const service = new LearnCommandService({ projectRoot: stateRef.current.path });
        void service.status().then(result => {
          const pending = result.drafts.filter(d => d.status === 'draft');
          const rejected = result.drafts.filter(d => d.status === 'rejected' || d.status === 'invalid');

          if (pending.length === 0 && result.learnedSkills.length === 0 && rejected.length === 0) {
            dispatch({ type: 'system.push', text: 'No learned skills yet. Use /learn to create one.', tone: 'info' });
            return;
          }
          if (pending.length > 0) {
            const lines = pending.flatMap(d => [
              `  [draft] ${d.name}`,
              `         /learn preview ${d.id}`,
              `         /learn apply ${d.id}`,
            ]);
            dispatch({ type: 'system.push', text: `Pending drafts (${pending.length}):\n${lines.join('\n')}`, tone: 'warn' });
          }
          if (result.learnedSkills.length > 0) {
            const lines = result.learnedSkills.map(s => `  /skill run ${s.name}`);
            dispatch({ type: 'system.push', text: `Applied skills (${result.learnedSkills.length}):\n${lines.join('\n')}`, tone: 'ok' });
          }
          if (rejected.length > 0) {
            dispatch({ type: 'system.push', text: `Rejected/invalid: ${rejected.map(d => d.name).join(', ')}`, tone: 'info' });
          }
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to read learn status: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
      case 'mcp.status': {
        void (runner.getMcpOverview?.() ?? Promise.resolve({ connected: [], failed: [], totalTools: 0, totalResources: 0, totalPrompts: 0 })).then((overview) => {
          dispatch({ type: 'system.push', text: formatMcpOverview(overview), tone: overview.failed.length > 0 ? 'warn' : 'info' });
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to inspect MCP status: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
      case 'mcp.resources': {
        void (runner.listMcpResources?.() ?? Promise.resolve([])).then((resources) => {
          dispatch({ type: 'system.push', text: formatMcpResourceList(resources), tone: 'info' });
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to list MCP resources: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
      case 'mcp.read': {
        if (!runner.readMcpResource) {
          dispatch({ type: 'system.push', text: 'MCP resource reader unavailable in the current runner.', tone: 'warn' });
          return;
        }
        void runner.readMcpResource(o.ref).then((payload) => {
          dispatch({ type: 'system.push', text: formatUnknownPayload(payload), tone: 'info' });
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to read MCP resource: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
      case 'mcp.prompts': {
        void (runner.listMcpPrompts?.() ?? Promise.resolve([])).then((prompts) => {
          dispatch({ type: 'system.push', text: formatMcpPromptList(prompts), tone: 'info' });
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to list MCP prompts: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
      case 'mcp.prompt': {
        if (!runner.getMcpPrompt) {
          dispatch({ type: 'system.push', text: 'MCP prompt reader unavailable in the current runner.', tone: 'warn' });
          return;
        }
        let parsedArgs: Record<string, unknown> | undefined;
        try {
          parsedArgs = parseJsonArgs(o.argsText);
        } catch (err) {
          dispatch({ type: 'system.push', text: `Invalid prompt args JSON: ${String((err as Error)?.message ?? err)}`, tone: 'warn' });
          return;
        }
        void runner.getMcpPrompt(o.name, parsedArgs).then((payload) => {
          dispatch({ type: 'system.push', text: formatUnknownPayload(payload), tone: 'info' });
        }).catch(err => {
          dispatch({ type: 'system.push', text: `Failed to read MCP prompt: ${String(err?.message ?? err)}`, tone: 'warn' });
        });
        return;
      }
    }
  }, [exit, dispatch, pipelineRunner, restoreSession, runner]);

  // Track which runner owns the currently in-flight turn so permission
  // resolutions route to the right side. EngineBridge and PipelineBridge each
  // maintain their own pending-approval map; sending the verdict to the wrong
  // one leaks the worker promise.
  const activeRunnerRef = useRef<Runner>(runner);
  const initialSessionLoadedRef = useRef(false);

  useEffect(() => {
    if (initialSessionLoadedRef.current || !initialSession) return;
    initialSessionLoadedRef.current = true;
    void restoreSession(initialSession).then(({ msgCount, ctxNote }) => {
      dispatch({ type: 'system.push', text: `Resumed "${initialSession.name}" (${msgCount} messages${ctxNote}).`, tone: 'ok' });
    }).catch(() => {
      dispatch({ type: 'system.push', text: `Failed to resume "${initialSession.name}".`, tone: 'warn' });
    });
  }, [dispatch, initialSession, restoreSession]);

  // Render the given permission prompt: flip pending state and push the panel.
  const presentPermission = useCallback((perm: ActivePermission) => {
    const args = perm.args;
    const cmd = String((args as any).command ?? (args as any).path ?? perm.tool);
    dispatch({ type: 'pending.set', value: 'permission' });
    dispatch({
      type: 'permission.show',
      perm: {
        tool: perm.tool,
        cmd: `$ ${cmd}`,
        cwd: stateRef.current.path,
        note: `${perm.description} — ⏎ allow · esc deny`,
        details: describePermissionArgs(args),
        risk: perm.risk,
      },
    });
  }, [dispatch]);

  // After answering the active prompt, surface the next queued one or clear.
  const advancePermission = useCallback(() => {
    const next = permQueueRef.current.next();
    if (next) presentPermission(next);
    else dispatch({ type: 'pending.clear' });
  }, [dispatch, presentPermission]);

  const allowPermission = useCallback(() => {
    const perm = permQueueRef.current.current;
    if (!perm) return;
    activeRunnerRef.current.resolvePermission?.(perm.id, { approved: true, reason: 'user approved' });
    dispatch({ type: 'system.push', text: `Allowed ${perm.tool}.`, tone: 'ok' });
    advancePermission();
  }, [dispatch, advancePermission]);

  const allowPermissionAlways = useCallback(() => {
    const runner = activeRunnerRef.current;
    // The user opted into full-auto, so approve the active prompt and every
    // request already queued behind it.
    const all = permQueueRef.current.drain();
    if (all.length === 0) return;
    for (const perm of all) {
      runner.resolvePermission?.(perm.id, { approved: true, reason: 'user approved always' });
    }
    runner.setApprovalMode?.('full-auto');
    dispatch({ type: 'pending.clear' });
    dispatch({ type: 'approval.change', mode: 'full-auto' });
    dispatch({ type: 'system.push', text: `Always allowing — switched to full-auto.`, tone: 'ok' });
  }, [dispatch]);

  const pickChoice = useCallback((optionId: string) => {
    choiceGate?.resolve({ type: 'pick', optionId });
    setActiveChoice(null);
    dispatch({ type: 'pending.clear' });
    dispatch({ type: 'system.push', text: `Choice: ${optionId}`, tone: 'ok' });
  }, [choiceGate, dispatch]);

  const cancelChoice = useCallback(() => {
    choiceGate?.resolve({ type: 'cancel' });
    setActiveChoice(null);
    dispatch({ type: 'pending.clear' });
    dispatch({ type: 'system.push', text: 'Choice cancelled.', tone: 'warn' });
  }, [choiceGate, dispatch]);

  const applyFix = useCallback(() => {
    dispatch({ type: 'pending.clear' });
    dispatch({ type: 'edits.clear' });
  }, [dispatch]);

  const dismissPending = useCallback((note: string) => {
    const perm = permQueueRef.current.current;
    if (perm) {
      activeRunnerRef.current.resolvePermission?.(perm.id, { approved: false, reason: 'user denied' });
      dispatch({ type: 'system.push', text: note, tone: 'warn' });
      advancePermission();
      return;
    }
    dispatch({ type: 'pending.clear' });
    dispatch({ type: 'system.push', text: note, tone: 'warn' });
  }, [dispatch, advancePermission]);

  // ── Submit handler (stable — uses stateRef, no state deps) ──────────
  // ── Shared streaming turn — used by both the single-agent loop and the
  //    orchestrator pipeline runner. ─────────────────────────────────────
  const W_PHASES = useMemo(() => new Set(['W0', 'W1', 'W0.5', 'W2/3', 'W3.5', 'W4']), []);
  const runTurn = useCallback((activeRunner: Runner, trimmed: string, isPipeline: boolean) => {
    activeRunnerRef.current = activeRunner;
    void (async () => {
      startChunkFlusher();
      turnToolCountRef.current = 0;
      turnUsageRef.current = null;
      stormMapRef.current.clear();
      // Drop any permission prompts left from a prior turn so they cannot leak
      // into this one.
      permQueueRef.current.clear();
      const ac = new AbortController();
      turnAbortRef.current = ac;
      dispatch({ type: 'turn.start' });
      if (isPipeline) dispatch({ type: 'pipeline.start' });
      // A single-agent turn has no pipeline/subagents; clear any leftover
      // orchestrate chrome so the first agent message starts with a clean
      // bottom area (e.g. after switching from orchestrate to agent mode).
      else dispatch({ type: 'pipeline.clear' });
      try {
        // ── Auto-retry wrapper (transient network / rate-limit errors) ──────
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (ac.signal.aborted) break;
          if (attempt > 0) {
            const delayMs = 500 * Math.pow(2, attempt - 1);
            dispatch({ type: 'system.push', text: `Network error — retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/3)…`, tone: 'warn' });
            await new Promise<void>(r => setTimeout(r, delayMs));
            stormMapRef.current.clear();
            if (ac.signal.aborted) break;
          }
          try {
        const iter = activeRunner.send(trimmed)[Symbol.asyncIterator]();
        // Manual iteration so we can race the next event against the abort
        // signal — double-Ctrl+C flips ac.abort() and we break out of the loop
        // even if the underlying stream is still mid-read.
        while (true) {
          if (ac.signal.aborted) break;
          const abortPromise = new Promise<{ aborted: true }>(resolve => {
            if (ac.signal.aborted) { resolve({ aborted: true }); return; }
            ac.signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true });
          });
          type Next = { aborted: false; result: IteratorResult<UiEvent> };
          const raced = await Promise.race<Next | { aborted: true }>([
            iter.next().then((r): Next => ({ aborted: false, result: r as IteratorResult<UiEvent> })),
            abortPromise,
          ]);
          if (raced.aborted) break;
          const result = raced.result;
          if (result.done) break;
          const ev = result.value;
          if (ev.kind === 'pipeline') {
            if (W_PHASES.has(ev.phase)) {
              dispatch({ type: 'pipeline.phase', phase: ev.phase, label: ev.label, detail: ev.detail });
            }
            continue;
          }
          if (ev.kind === 'permission_request') {
            // Queue control: show this prompt only if nothing is already
            // awaiting an answer; otherwise it waits its turn.
            const show = permQueueRef.current.submit({ id: ev.id, tool: ev.tool, args: ev.args, risk: ev.risk, description: ev.description });
            if (show) presentPermission(show);
            continue;
          }
          if (ev.kind === 'tool') {
            const fname = extractFileArg(ev.args);
            if (fname) {
              dispatch({ type: 'files.set', files: touch(stateRef.current.files, { name: fname, meta: ev.name }) });
            }
            turnToolCountRef.current += 1;
            // ── Storm detection ────────────────────────────────────────────
            // Status-update tools (todo_write/todo_read) are exempt — the model
            // legitimately re-emits them per progress tick, and duplicates here
            // don't mean it's stuck.
            if (!STORM_EXEMPT_TOOLS.has(ev.name)) {
              const stormKey = `${ev.name}\x00${ev.args.slice(0, 120)}`;
              const stormCount = (stormMapRef.current.get(stormKey) ?? 0) + 1;
              stormMapRef.current.set(stormKey, stormCount);
              if (stormCount >= STORM_THRESHOLD) {
                dispatch({ type: 'error.push', title: `Loop detected — turn aborted`, lines: [
                  `${ev.name} called ${stormCount}× with identical args.`,
                  'The model may be stuck in a loop. Try rephrasing your request.',
                ], hint: '/clear to reset · u to undo last edit' });
                break;
              }
            }
            const toolId = tid();
            const displayArgs = summarizeTool(ev.name, ev.args);
            lastToolIdRef.current = toolId;
            lastToolDescRef.current = `${ev.name} · ${displayArgs}`;
            dispatch({ type: 'tool.start', id: toolId, name: ev.name, args: displayArgs });
            continue;
          }
          if (ev.kind === 'tool_result') {
            if (lastToolIdRef.current) {
              const meta = summarizeToolResult(ev.ok, ev.content);
              // Capture output lines (capped) so the result can be expanded in verbose mode.
              const output = ev.content
                ? ev.content.split('\n').filter(l => l.trim() !== '').slice(0, 40)
                : undefined;
              dispatch({ type: 'tool.end', id: lastToolIdRef.current, ok: ev.ok, meta: meta || undefined, output });
              lastToolIdRef.current = null;
            }
            if (ev.ok) {
              const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'edit', 'apply_patch']);
              if (EDIT_TOOLS.has(ev.name)) {
                const sign = ev.name === 'write_file' ? '+' : '~';
                const label = lastToolDescRef.current ?? ev.name;
                dispatch({ type: 'edit.add', edit: { sign, label } });
              }
            } else {
              dispatch({
                type: 'error.push',
                title: `${ev.name} failed`,
                lines: buildErrorLines(`${ev.name} failed`, ev.content),
                context: lastToolDescRef.current ?? undefined,
                hint: 'ctrl+r expand full output · u undo last edit',
              });
            }
            lastToolDescRef.current = null;
            continue;
          }
          if (ev.kind === 'streaming_reasoning') {
            reasoningBufferRef.current += ev.text;
            // Cap accumulated reasoning to keep the live region bounded.
            if (reasoningBufferRef.current.length > REASONING_CHAR_CAP) {
              reasoningBufferRef.current = reasoningBufferRef.current.slice(-REASONING_CHAR_CAP);
            }
            scheduleChunkFlush();
            continue;
          }
          if (ev.kind === 'usage') {
            turnUsageRef.current = {
              totalTokens: ev.totalTokens,
              toolCalls: ev.toolCalls,
              steps: ev.steps,
              totalCost: ev.totalCost,
              currency: ev.currency,
            };
            // NEW: drive the Context meter from live context occupancy rather
            // than cumulative session token spend.
            dispatch({ type: 'ctx.update', used: getContextUsageK(ev) });
            // Always thread token splits — they're cumulative session totals
            // so the meter/cacheHit reflect the latest snapshot even on a
            // cost-free turn (full cache hit).
            const costDelta = Math.max(0, ev.totalCost - prevCostRef.current);
            prevCostRef.current = ev.totalCost;
            dispatch({
              type: 'usage.update',
              promptTokens: ev.promptTokens,
              completionTokens: ev.completionTokens,
              cachedTokens: ev.cachedTokens,
              cost: costDelta,
              currency: ev.currency,
            });
            continue;
          }
          if (ev.kind === 'subagent_progress') {
            dispatch({
              type: 'subagent.update',
              taskId: ev.taskId,
              personaId: ev.personaId,
              objective: ev.objective,
              step: ev.step,
              maxSteps: ev.maxSteps,
              toolCalls: ev.toolCalls,
              ...(ev.lastTool !== undefined && { lastTool: ev.lastTool }),
              ...(ev.lastToolArgs !== undefined && { lastToolArgs: ev.lastToolArgs }),
              tokens: ev.tokens,
              cost: ev.cost,
              currency: ev.currency,
              status: ev.status,
            });
            continue;
          }
          if (ev.kind === 'plan') {
            const steps: PlanStep[] = ev.steps.map(s => ({ label: s.label, status: PLAN_STATUS[s.status] }));
            const inProgress = ev.steps.find(s => s.status === 'in_progress');
            const idx = inProgress
              ? ev.steps.indexOf(inProgress) + 1
              : ev.steps.filter(s => s.status === 'completed').length + 1;
            dispatch({
              type: 'plan.set',
              title: stateRef.current.plan.title === '(no plan yet)' ? 'agent plan' : stateRef.current.plan.title,
              steps,
            });
            if (inProgress) {
              dispatch({ type: 'system.push', text: `STEP ${idx} · ${inProgress.label.toUpperCase()}`, tone: 'info' });
            }
            continue;
          }
          if (ev.kind === 'streaming') {
            chunkBufferRef.current += ev.text;
            chunkCountRef.current++;
            if (chunkCountRef.current >= 8) {
              flushChunks();
            } else {
              scheduleChunkFlush();
            }
            continue;
          }
          const msgs = uiEventToMessages(ev);
          for (const msg of msgs) {
            if (msg.type === 'system') dispatch({ type: 'system.push', text: msg.text, tone: msg.tone });
            else if (msg.type === 'assistant') {
              // The final event carries the complete text, so any chunks still
              // buffered are superseded. Drop them (and cancel the pending
              // flush) so they can't resurrect a stray streaming frame after
              // the message is committed.
              if (chunkFlushTimerRef.current) {
                clearTimeout(chunkFlushTimerRef.current);
                chunkFlushTimerRef.current = null;
              }
              chunkBufferRef.current = '';
              dispatch({ type: 'assistant.final', text: msg.text });
            }
            else if (msg.type === 'error') dispatch({ type: 'error.push', title: msg.error.title, lines: msg.error.lines });
            else if (msg.type === 'tool') dispatch({ type: 'tool.start', id: msg.id, name: msg.tool.kind, args: msg.tool.args });
          }
        }
            lastErr = null;
            break; // success — exit retry loop
          } catch (err: unknown) {
            const msg = String((err as any)?.message ?? err).toLowerCase();
            const retryable = RETRYABLE_PATTERNS.some(p => msg.includes(p));
            if (retryable && attempt < 2) { lastErr = err; continue; }
            lastErr = err;
            break;
          }
        } // end retry loop
        if (lastErr) throw lastErr;
      } catch (err: any) {
        dispatch({ type: 'error.push', title: 'runner error', lines: buildErrorLines('runner error', String(err?.message ?? err)) });
      } finally {
        const wasAborted = ac.signal.aborted;
        if (turnAbortRef.current === ac) turnAbortRef.current = null;
        stopChunkFlusher();
        if (isPipeline) dispatch({ type: 'pipeline.end' });
        if (wasAborted) {
          dispatch({ type: 'system.push', text: 'Task cancelled (Ctrl+C ×2).', tone: 'warn' });
        }
        dispatch({ type: 'turn.end', success: !wasAborted });
        // End-of-turn telemetry summary, rendered as an informative divider.
        const u = turnUsageRef.current;
        const tools = turnToolCountRef.current;
        if (u || tools > 0) {
          const parts: string[] = [];
          const steps = u?.steps ?? 0;
          if (steps > 0) parts.push(`${steps} step${steps > 1 ? 's' : ''}`);
          if (tools > 0) parts.push(`${tools} tool${tools > 1 ? 's' : ''}`);
          if (u && u.totalTokens > 0) parts.push(`${(u.totalTokens / 1000).toFixed(1)}k tok`);
          if (u && u.totalCost > 0) {
            const symbol = u.currency === 'Credits' ? 'C' : '¥';
            const digits = u.currency === 'Credits' ? 1 : 2;
            parts.push(`${symbol}${u.totalCost.toFixed(digits)}`);
          }
          if (parts.length) dispatch({ type: 'turnmeta.push', summary: parts.join(' · ') });
        }
        // Phase 2: commit all messages from this turn into the Static scrollback layer.
        dispatch({ type: 'messages.commit' });
      }
    })();
  }, [dispatch, startChunkFlusher, scheduleChunkFlush, stopChunkFlusher, W_PHASES, presentPermission]);

  const cancelCurrentTurn = useCallback(() => {
    const ac = turnAbortRef.current;
    if (ac && !ac.signal.aborted) ac.abort();
  }, []);

  // Shift+Tab cycles through the three user-facing permission modes. The full
  // ApprovalMode union also includes "suggest" and "never" but those are
  // command-driven (/perm ...) corners, not part of the keyboard cycle.
  const APPROVAL_CYCLE: ReadonlyArray<ApprovalMode> = useMemo(
    () => ['read-only', 'auto-edit', 'full-auto'],
    [],
  );
  const cycleApprovalMode = useCallback(() => {
    const cur = stateRef.current.approvalMode;
    const idx = APPROVAL_CYCLE.indexOf(cur);
    const next = APPROVAL_CYCLE[(idx + 1) % APPROVAL_CYCLE.length] ?? 'auto-edit';
    runner.setApprovalMode?.(next);
    dispatch({ type: 'approval.change', mode: next });
    dispatch({ type: 'toast.show', text: `Permission: ${next}`, tone: 'info', ttlMs: 2000 });
  }, [APPROVAL_CYCLE, runner, dispatch]);

  const handleSubmit = useCallback((text: string) => {
    const st = stateRef.current;

    if (!text.trim() && st.pending === 'permission') { allowPermission(); return; }
    if (!text.trim() && st.pending === 'error') { applyFix(); return; }

    if (text.startsWith('/')) {
      const outcome = runCommand(text, st, cmdCtx);
      if (outcome.kind === 'pipeline') {
        if (!pipelineRunner) {
          dispatch({ type: 'system.push', text: 'Pipeline runner unavailable (engine not built or no API key).', tone: 'warn' });
          return;
        }
        if (st.pending) dispatch({ type: 'pending.clear' });
        dispatch({ type: 'user.submit', text: `/orchestrate ${outcome.text}` });
        runTurn(pipelineRunner, outcome.text, true);
        return;
      }
      if (outcome.kind === 'plan.start') {
        dispatch({ type: 'planmode.set', enabled: true });
        runner.setPlanMode?.(true);
        if (st.pending) dispatch({ type: 'pending.clear' });
        dispatch({ type: 'user.submit', text: `/plan ${outcome.task}` });
        runTurn(runner, outcome.task, false);
        return;
      }
      applyOutcome(outcome);
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) return;
    if (st.pending) dispatch({ type: 'pending.clear' });

    if (st.mode === 'orchestrate') {
      if (!pipelineRunner) {
        dispatch({ type: 'system.push', text: 'Pipeline runner unavailable (engine not built or no API key).', tone: 'warn' });
        return;
      }
      dispatch({ type: 'user.submit', text: trimmed });
      runTurn(pipelineRunner, trimmed, true);
      return;
    }

    dispatch({ type: 'user.submit', text: trimmed });
    runTurn(runner, trimmed, false);
  }, [runner, pipelineRunner, dispatch, allowPermission, applyFix, applyOutcome, cmdCtx, runTurn]);

  const handleToastDismiss = useCallback((id: string) => {
    dispatch({ type: 'toast.dismiss', id });
  }, [dispatch]);

  // ── Extract slices for zone props ───────────────────────────────────
  const sPath = useSlice(state, s => s.path);
  const sBranch = useSlice(state, s => s.branch);
  const sMode = useSlice(state, s => s.mode);
  const sPending = useSlice(state, s => s.pending);
  const sPlanTitle = useSlice(state, s => s.plan.title);
  const sPlanSteps = useSlice(state, s => s.plan.steps);
  const sPipeline = useSlice(state, s => s.pipeline);
  const sSubagents = useSlice(state, s => s.subagents);
  const sFiles = useSlice(state, s => s.files);
  const sEdits = useSlice(state, s => s.edits);
  const sMessages  = useSlice(state, s => s.messages);
  const sCommittedCount = useSlice(state, s => s.committedCount);
  const sHelpOpen  = useSlice(state, s => s.helpOpen);
  const sStepLabel = useSlice(state, s => s.currentStepLabel);
  const sActiveTool = useSlice(state, s => s.activeTool);
  const sPetVisible = useSlice(state, s => s.petVisible);
  const sStreaming = useSlice(state, s => s.streaming);
  const sReasoning = useSlice(state, s => s.reasoning);
  const sApprovalMode = useSlice(state, s => s.approvalMode);
  const sCtxUsed = useSlice(state, s => s.ctx.used);
  const sCtxMax = useSlice(state, s => s.ctx.max);
  const sUsage = useSlice(state, s => s.usage);
  const sMcpLoading = useSlice(state, s => s.mcpLoading);
  const sToasts = useSlice(state, s => s.toasts);
  const sPlanMode = useSlice(state, s => s.planMode);
  const sVerbose = useSlice(state, s => s.verbose);
  const sHasEdits = useSlice(state, s => s.edits.length > 0);
  const sHasMessages = useMemo(
    () => sMessages.some(m => m.type !== 'system'),
    [sMessages],
  );

  // ── Keep the live (repainting) region minimal ───────────────────────
  // Continuously commit the longest *settled* prefix of messages into the
  // <Static> scrollback — even mid-turn. The repainting region then only
  // ever holds the in-flight tail (a running tool + the streaming frame),
  // so its height stays far below the terminal height and Ink never falls
  // back to clearing + reprinting the whole screen (the flicker path).
  //
  // A message is settled unless it's a tool whose tool.end hasn't fired
  // yet (status undefined). We stop at the first such tool so a still
  // mutating row is never frozen into Static (tool.end mutates by id). The
  // streaming assistant text lives in `streaming`, not in messages, so it
  // never blocks the prefix.
  const settledCount = useMemo(() => {
    let n = 0;
    for (; n < sMessages.length; n++) {
      const m = sMessages[n]!;
      if (m.type === 'tool' && m.tool.status === undefined) break;
    }
    return n;
  }, [sMessages]);
  useEffect(() => {
    if (settledCount > sCommittedCount) {
      dispatch({ type: 'messages.commit', count: settledCount });
    }
  }, [settledCount, sCommittedCount, dispatch]);

  // ── Auto-save session after each turn ───────────────────────────────
  const sTurnInProgress = useSlice(state, s => s.turnInProgress);
  const prevTurnInProgressRef = useRef(false);
  useEffect(() => {
    const justFinished = prevTurnInProgressRef.current && !sTurnInProgress;
    prevTurnInProgressRef.current = sTurnInProgress;
    if (!justFinished) return;
    const s = stateRef.current;
    const msgs = s.messages;
    if (msgs.length === 0) return;
    // P1: 使用当前活跃 runner 获取 chatHistory，而非固定使用全局 runner
    // P2: 从 stateRef 获取 messages，避免 sMessages 变化导致 Effect 频繁重注册
    void saveTuiSession({
      id: sessionIdRef.current,
      name: s.sessionName ?? sessionIdRef.current,
      projectPath: s.path,
      messages: msgs,
      chatHistory: activeRunnerRef.current.getHistory?.(),
      engineSessionId: runner.getSessionId?.() ?? undefined,
      createdAt: sessionCreatedAtRef.current,
      updatedAt: Date.now(),
    }).catch(() => {/* best-effort */});
  }, [sTurnInProgress]);

  // ── Context-window pressure warnings ───────────────────────────────
  // Fires a toast at each threshold once per session so the user knows
  // to consider /clear before the window fills and costs spike.
  const ctxWarnedRef = useRef(new Set<number>());
  useEffect(() => {
    if (!sCtxMax || !sCtxUsed) return;
    const ratio = sCtxUsed / sCtxMax;
    for (const t of CTX_WARN_THRESHOLDS) {
      if (ratio >= t && !ctxWarnedRef.current.has(t)) {
        ctxWarnedRef.current.add(t);
        dispatch({ type: 'toast.show', text: `Context ${Math.round(t * 100)}% full — /clear to reset`, tone: 'warn', ttlMs: 8000 });
      }
    }
  }, [sCtxUsed, sCtxMax, dispatch]);

  // ── Sync planMode → engine ───────────────────────────────────────────
  useEffect(() => {
    runner.setPlanMode?.(sPlanMode);
  }, [sPlanMode, runner]);

  // ── Text-wrap width for dividers / turn-meta rules ──────────────────
  // No sidebar any more: the chat uses (nearly) the full terminal width.
  const chatCols = Math.max(40, termSize.cols - 2);

  // ── Bottom chrome height for streamCap calculation ───────────────────
  // Rows consumed by UI below ChatStream so ChatStream can compute an
  // accurate streamCap.  Compact plan (> 4 steps) = 1 row; card plan = 2;
  // no plan = 0.  Pipeline adds 1 row per phase + 1 header.
  const bottomReserved = useMemo(() => {
    const CHROME = 8; // TitleBar(1) + InputArea(3) + StatusBar(1) + box chrome
    const planRows = sPlanSteps.length === 0 ? 0
      : sPlanSteps.length > 4 ? 1    // compact single-line strip
      : 2;                            // title row + steps row
    // Bordered panel: round border (2 rows) + header + stage rail (may wrap once
    // on narrow terminals) + active-stage detail line. No longer scales with
    // phase count.
    const pipelineRows = sPipeline ? 6 : 0;
    // SubagentBrief bordered panel: round border (2 rows) + header + N visible
    // rows (capped at MAX_VISIBLE=4) + 1 if more are hidden behind a "…N more".
    const subagentVisible = Math.min(sSubagents.length, 4);
    const subagentRows = sSubagents.length === 0
      ? 0
      : 2 + 1 + subagentVisible + (sSubagents.length > 4 ? 1 : 0);
    const toastRows = sToasts.length;
    return CHROME + planRows + pipelineRows + subagentRows + toastRows;
  }, [sPlanSteps, sPipeline, sSubagents, sToasts]);

  const titleMode =
    sPending === 'permission' ? 'agent · paused'
    : sPending === 'choice'   ? 'agent · waiting'
    : sPending === 'error' ? 'agent · interrupted'
    : sPlanMode ? `${sMode} · plan mode`
    : sMode;
  const statusState: SessionState =
    sPending === 'permission' ? 'paused'
    : sPending === 'choice'   ? 'paused'
    : sPending === 'error' ? 'error'
    : sMode === 'orchestrate' ? 'orchestrate'
    : sMode === 'agent' ? 'agent' : 'mimo';

  // Stabilize the ChatZone header element. Built inline it would be a fresh
  // React node every render, which defeats ChatZone's React.memo and forces the
  // heavy ChatStream to repaint on every unrelated state change (usage ticks,
  // toasts, pipeline phases). Memoizing it lets ChatZone skip when only the
  // bottom chrome changed.
  const chatHeader = useMemo(() => (
    <Box flexDirection="column">
      <TitleZone path={sPath} branch={sBranch} mode={titleMode} />
      {!sHasMessages && <WelcomeScreen path={sPath} engine={engineInfo} cols={chatCols} />}
    </Box>
  ), [sPath, sBranch, titleMode, sHasMessages, engineInfo, chatCols]);

  // ── Render: Claude Code style inline conversation flow ──────────────
  // The conversation (ChatZone) owns the terminal scrollback; the plan,
  // pipeline, toast, input and status bar form the live frame anchored at
  // the bottom of the terminal and repainted in place.
  return (
    <Box flexDirection="column">
      <ChatZone
        messages={sMessages}
        committedCount={sCommittedCount}
        stepLabel={sStepLabel}
        activeTool={sActiveTool}
        petVisible={sPetVisible}
        streaming={sStreaming}
        reasoning={sReasoning}
        verbose={sVerbose}
        cols={chatCols}
        maxRows={termSize.rows}
        reservedRows={bottomReserved}
        resizeRevision={termSize.revision}
        header={chatHeader}
      />

      <PlanZone title={sPlanTitle} steps={sPlanSteps} />
      <PipelineZone phases={sPipeline} />
      <SubagentBrief subagents={sSubagents} />

      <ToastBar toasts={sToasts} onDismiss={handleToastDismiss} />

      <InputArea
        files={sFiles}
        helpOpen={sHelpOpen}
        pending={sPending}
        choiceRequest={activeChoice}
        hasMessages={sHasMessages}
        mode={sMode}
        verbose={sVerbose}
        hasEdits={sHasEdits}
        turnInProgress={sTurnInProgress}
        onSubmit={handleSubmit}
        onPermAllow={allowPermission}
        onPermAlwaysAllow={allowPermissionAlways}
        onPermDeny={dismissPending}
        onApplyFix={applyFix}
        onChoicePick={pickChoice}
        onChoiceCancel={cancelChoice}
        onCancelTurn={cancelCurrentTurn}
        approvalMode={sApprovalMode}
        onCycleApprovalMode={cycleApprovalMode}
        dispatch={dispatch}
        cmdCtx={cmdCtx}
      />

      <StatusZone
        statusState={statusState}
        approvalMode={sApprovalMode}
        ctxUsed={sCtxUsed}
        ctxMax={sCtxMax}
        hint={[
          sMessages.length > 0 && `${sMessages.length}msg`,
          sEdits.length > 0 && `${sEdits.length} staged`,
          sBranch,
        ].filter(Boolean).join(' · ')}
        usage={sUsage}
        mcpLoading={sMcpLoading}
      />
    </Box>
  );
}

// ── /init handler ─────────────────────────────────────────────────────
async function runInit(cwd: string, dispatch: Dispatch, args?: string[]) {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const isReset = args?.includes('--reset') ?? false;

  const configDir = path.join(cwd, '.minimum');
  const configPath = path.join(configDir, 'config.json');
  const globalConfigDir = path.join(os.homedir(), '.minimum');
  const globalConfigPath = path.join(globalConfigDir, 'config.json');
  let projectConfigExists = false;
  let globalConfigExists = false;
  try { await fs.access(globalConfigPath); globalConfigExists = true; } catch { /* global config missing */ }

  if (!isReset) {
    try {
      await fs.access(configPath);
      projectConfigExists = true;
      if (!globalConfigExists) throw new Error('global config missing');
      dispatch({ type: 'toast.show', text: 'config already exists. Use /init --reset to reinitialize project + global config.', tone: 'warn', ttlMs: 5000 });
      return;
    } catch { /* doesn't exist yet — proceed */ }
  }

  const apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) {
    dispatch({ type: 'system.push', text: 'MIMO_API_KEY not set. Set it and retry:', tone: 'warn' });
    dispatch({ type: 'system.push', text: '  export MIMO_API_KEY="sk-xxxxx"  (or tp-xxxxx for Token Plan)', tone: 'info' });
    dispatch({ type: 'system.push', text: 'Get your key at: https://platform.xiaomimimo.com/#/console/api-keys', tone: 'info' });
    dispatch({ type: 'toast.show', text: '/init needs MIMO_API_KEY', tone: 'warn', ttlMs: 5000 });
    return;
  }

  // Detect project type from marker files
  const markers: Array<{ file: string; type: string }> = [
    { file: 'package.json',   type: 'node' },
    { file: 'tsconfig.json',  type: 'typescript' },
    { file: 'pyproject.toml', type: 'python' },
    { file: 'Cargo.toml',     type: 'rust' },
    { file: 'go.mod',         type: 'go' },
    { file: 'pom.xml',        type: 'java' },
    { file: 'build.gradle',   type: 'java' },
    { file: 'Gemfile',        type: 'ruby' },
    { file: 'composer.json',  type: 'php' },
  ];
  const detected: string[] = [];
  for (const m of markers) {
    try { await fs.access(path.join(cwd, m.file)); detected.push(m.type); } catch { /* skip */ }
  }
  const projectType = detected[0] ?? 'unknown';

  // Auto-select endpoint from key prefix
  const isTokenPlan = apiKey.startsWith('tp-');
  const baseUrl = isTokenPlan
    ? 'https://token-plan-cn.xiaomimimo.com/v1'
    : 'https://api.xiaomimimo.com/v1';

  const config = {
    apiKey,
    baseUrl,
    defaultModel: 'mimo-v2.5-pro',
    maxTokens: 131072,
    maxSteps: 50,
    approvalMode: 'suggest',
    enableReadGuard: true,
    context:      { foldThreshold: 0.70, aggressiveThreshold: 0.75, tailFraction: 0.25 },
    capacity:     { enabled: true, lowRiskMax: 0.50, mediumRiskMax: 0.62 },
    storm:        { windowSize: 6, threshold: 3 },
    validation:   { enabled: true, syntax: true, tsc: true, pattern: true },
    completeness: { enabled: true },
  };

  const projectConfig = { ...config, apiKey: undefined, baseUrl: undefined };
  if (isReset || !projectConfigExists) {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(projectConfig, null, 2) + '\n', 'utf-8');
  }
  if (isReset || !globalConfigExists) {
    await fs.mkdir(globalConfigDir, { recursive: true });
    await fs.writeFile(globalConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    try { await fs.chmod(globalConfigPath, 0o600); } catch { /* Windows / non-POSIX filesystems */ }
  }
  const created = [
    isReset || !projectConfigExists ? '.minimum/config.json' : null,
    isReset || !globalConfigExists ? '~/.minimum/config.json' : null,
  ].filter(Boolean).join(' + ');

  dispatch({ type: 'toast.show', text: `/init complete - ${created} ready`, tone: 'ok', ttlMs: 5000 });
  dispatch({ type: 'system.push', text: `Project type: ${projectType}`, tone: 'info' });
  dispatch({ type: 'system.push', text: `API: ${isTokenPlan ? 'Token Plan' : 'Pay-as-you-go'} · ${baseUrl}`, tone: 'info' });
  dispatch({ type: 'system.push', text: `Model: mimo-v2.5-pro · 1M ctx · 131k out`, tone: 'info' });
  dispatch({ type: 'system.push', text: `Project config: ${configPath} (no apiKey)`, tone: 'info' });
  dispatch({ type: 'system.push', text: `Global config: ${globalConfigPath} (contains apiKey)`, tone: 'info' });
}
