import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Box, useApp } from 'ink';
import { TitleBar }       from './components/TitleBar.js';
import { PlanStrip }      from './components/PlanStrip.js';
import { PipelinePanel }  from './components/PipelinePanel.js';
import { ChatStream }     from './components/ChatStream.js';
import { StatusBar }      from './components/StatusBar.js';
import { WelcomeScreen }  from './components/WelcomeScreen.js';
import { ToastBar }       from './components/ToastBar.js';
import { InputArea }      from './components/InputArea.js';
import { createInitialState } from './seed.js';
import {
  runCommand, type CommandOutcome, type CommandContext,
} from './commands.js';
import { mockRunner, uiEventToMessages, summarizeTool, summarizeToolResult, describePermissionArgs, type Runner, type EngineInfo, type UiPlanStatus } from './engine.js';
import { scanFiles, readBranch, touch } from './files.js';
import {
  saveTuiSession, loadTuiSessionById, listTuiSessions, formatSessionList,
  type TuiSession,
} from './session.js';
import { useAgentStore, useSlice, type Dispatch } from './state/store.js';
import type { AppState, Message, FileEntry, SessionState, PlanStep, PendingState, ApprovalMode, UsageInfo, Mode, StagedEdit } from './types.js';

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

// ── Loop-guard tunables ───────────────────────────────────────────────
/** Abort turn when the same tool+args fires this many times in a row. */
const STORM_THRESHOLD = 3;
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
}: { runner?: Runner; pipelineRunner?: Runner; engineInfo?: EngineInfo } = {}) {
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
  const [activePerm, setActivePerm] = useState<ActivePermission | null>(null);
  // Mutable refs so callbacks that close over these stay stable
  const stateRef = useRef(state);
  stateRef.current = state;
  const activePermRef = useRef(activePerm);
  activePermRef.current = activePerm;
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
  const turnUsageRef = useRef<{ totalTokens: number; toolCalls: number; steps: number; totalCostUsd: number } | null>(null);
  // Tracks cumulative cost at the start of the current turn to compute per-turn delta.
  const prevCostRef = useRef(0);

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
    dispatch({ type: 'ctx.update', used: 0, max: 200 });
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

  const cmdCtx: CommandContext = useMemo(() => ({
    model: engineInfo.model,
    tools: engineInfo.tools,
    configPath: engineInfo.configPath,
    memoryPath: engineInfo.memoryPath,
    baseUrl: engineInfo.baseUrl,
    engineMode: engineInfo.mode,
  }), [engineInfo]);
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
          chatHistory: runner.getHistory?.(),
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
          sessionIdRef.current = session.id;
          sessionCreatedAtRef.current = session.createdAt;
          prevCostRef.current = 0;
          // Restore engine conversation history so the AI has full prior context.
          if (session.chatHistory?.length) {
            runner.loadHistory?.(session.chatHistory);
          }
          dispatch({ type: 'session.restore', messages: session.messages, sessionName: session.name });
          const msgCount = session.messages.filter(m => m.type === 'user' || m.type === 'assistant').length;
          const ctxNote = session.chatHistory?.length ? ` · AI context restored (${session.chatHistory.length} turns)` : '';
          dispatch({ type: 'system.push', text: `Loaded "${session.name}" (${msgCount} messages${ctxNote}).`, tone: 'ok' });
        }).catch(() => {
          dispatch({ type: 'system.push', text: `Failed to load session "${name}".`, tone: 'warn' });
        });
        return;
      }
    }
  }, [exit, dispatch, runner]);

  const allowPermission = useCallback(() => {
    const perm = activePermRef.current;
    if (!perm) return;
    runner.resolvePermission?.(perm.id, { approved: true, reason: 'user approved' });
    setActivePerm(null);
    dispatch({ type: 'pending.clear' });
    dispatch({ type: 'system.push', text: `Allowed ${perm.tool}.`, tone: 'ok' });
  }, [runner, dispatch]);

  const allowPermissionAlways = useCallback(() => {
    const perm = activePermRef.current;
    if (!perm) return;
    runner.resolvePermission?.(perm.id, { approved: true, reason: 'user approved always' });
    runner.setApprovalMode?.('full-auto');
    setActivePerm(null);
    dispatch({ type: 'pending.clear' });
    dispatch({ type: 'approval.change', mode: 'full-auto' });
    dispatch({ type: 'system.push', text: `Always allowing — switched to full-auto.`, tone: 'ok' });
  }, [runner, dispatch]);

  const applyFix = useCallback(() => {
    dispatch({ type: 'pending.clear' });
    dispatch({ type: 'edits.clear' });
  }, [dispatch]);

  const dismissPending = useCallback((note: string) => {
    const perm = activePermRef.current;
    if (perm) {
      runner.resolvePermission?.(perm.id, { approved: false, reason: 'user denied' });
      setActivePerm(null);
    }
    dispatch({ type: 'pending.clear' });
    dispatch({ type: 'system.push', text: note, tone: 'warn' });
  }, [runner, dispatch]);

  // ── Submit handler (stable — uses stateRef, no state deps) ──────────
  // ── Shared streaming turn — used by both the single-agent loop and the
  //    orchestrator pipeline runner. ─────────────────────────────────────
  const W_PHASES = useMemo(() => new Set(['W0', 'W1', 'W0.5', 'W2/3', 'W3.5', 'W4']), []);
  const runTurn = useCallback((activeRunner: Runner, trimmed: string, isPipeline: boolean) => {
    void (async () => {
      startChunkFlusher();
      turnToolCountRef.current = 0;
      turnUsageRef.current = null;
      stormMapRef.current.clear();
      dispatch({ type: 'turn.start' });
      if (isPipeline) dispatch({ type: 'pipeline.start' });
      try {
        // ── Auto-retry wrapper (transient network / rate-limit errors) ──────
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) {
            const delayMs = 500 * Math.pow(2, attempt - 1);
            dispatch({ type: 'system.push', text: `Network error — retrying in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/3)…`, tone: 'warn' });
            await new Promise<void>(r => setTimeout(r, delayMs));
            stormMapRef.current.clear();
          }
          try {
        for await (const ev of activeRunner.send(trimmed)) {
          if (ev.kind === 'pipeline') {
            if (W_PHASES.has(ev.phase)) {
              dispatch({ type: 'pipeline.phase', phase: ev.phase, label: ev.label, detail: ev.detail });
            }
            continue;
          }
          if (ev.kind === 'permission_request') {
            const args = ev.args;
            const cmd = String((args as any).command ?? (args as any).path ?? ev.tool);
            setActivePerm({ id: ev.id, tool: ev.tool, args, risk: ev.risk, description: ev.description });
            dispatch({ type: 'pending.set', value: 'permission' });
            dispatch({
              type: 'permission.show',
              perm: {
                tool: ev.tool,
                cmd: `$ ${cmd}`,
                cwd: stateRef.current.path,
                note: `${ev.description} — ⏎ allow · esc deny`,
                details: describePermissionArgs(args),
                risk: ev.risk,
              },
            });
            continue;
          }
          if (ev.kind === 'tool') {
            const fname = extractFileArg(ev.args);
            if (fname) {
              dispatch({ type: 'files.set', files: touch(stateRef.current.files, { name: fname, meta: ev.name }) });
            }
            turnToolCountRef.current += 1;
            // ── Storm detection ────────────────────────────────────────────
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
                lines: ev.content.split('\n').filter(l => l.trim() !== '').slice(0, 6),
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
              totalCostUsd: ev.totalCostUsd,
            };
            dispatch({ type: 'ctx.update', used: Number((ev.totalTokens / 1000).toFixed(1)) });
            const costDelta = Math.max(0, ev.totalCostUsd - prevCostRef.current);
            prevCostRef.current = ev.totalCostUsd;
            if (costDelta > 0) {
              dispatch({ type: 'usage.update', cost: costDelta, completionTokens: ev.totalTokens });
            }
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
        dispatch({ type: 'error.push', title: 'runner error', lines: [String(err?.message ?? err)] });
      } finally {
        stopChunkFlusher();
        if (isPipeline) dispatch({ type: 'pipeline.end' });
        dispatch({ type: 'turn.end', success: true });
        // End-of-turn telemetry summary, rendered as an informative divider.
        const u = turnUsageRef.current;
        const tools = turnToolCountRef.current;
        if (u || tools > 0) {
          const parts: string[] = [];
          const steps = u?.steps ?? 0;
          if (steps > 0) parts.push(`${steps} step${steps > 1 ? 's' : ''}`);
          if (tools > 0) parts.push(`${tools} tool${tools > 1 ? 's' : ''}`);
          if (u && u.totalTokens > 0) parts.push(`${(u.totalTokens / 1000).toFixed(1)}k tok`);
          if (u && u.totalCostUsd > 0) parts.push(`$${u.totalCostUsd.toFixed(2)}`);
          if (parts.length) dispatch({ type: 'turnmeta.push', summary: parts.join(' · ') });
        }
        // Phase 2: commit all messages from this turn into the Static scrollback layer.
        dispatch({ type: 'messages.commit' });
      }
    })();
  }, [dispatch, startChunkFlusher, scheduleChunkFlush, stopChunkFlusher, W_PHASES]);

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
    if (!justFinished || sMessages.length === 0) return;
    const s = stateRef.current;
    void saveTuiSession({
      id: sessionIdRef.current,
      name: s.sessionName ?? sessionIdRef.current,
      projectPath: s.path,
      messages: sMessages,
      chatHistory: runner.getHistory?.(),
      createdAt: sessionCreatedAtRef.current,
      updatedAt: Date.now(),
    }).catch(() => {/* best-effort */});
  }, [sTurnInProgress, sMessages]);

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
    const pipelineRows = sPipeline ? sPipeline.length + 1 : 0;
    const toastRows = sToasts.length;
    return CHROME + planRows + pipelineRows + toastRows;
  }, [sPlanSteps, sPipeline, sToasts]);

  const titleMode =
    sPending === 'permission' ? 'agent · paused'
    : sPending === 'error' ? 'agent · interrupted'
    : sPlanMode ? `${sMode} · plan mode`
    : sMode;
  const statusState: SessionState =
    sPending === 'permission' ? 'paused'
    : sPending === 'error' ? 'error'
    : sMode === 'orchestrate' ? 'orchestrate'
    : sMode === 'agent' ? 'agent' : 'mimo';

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
        header={
          <Box flexDirection="column">
            <TitleZone path={sPath} branch={sBranch} mode={titleMode} />
            {!sHasMessages && <WelcomeScreen path={sPath} engine={engineInfo} cols={chatCols} />}
          </Box>
        }
      />

      <PlanZone title={sPlanTitle} steps={sPlanSteps} />
      <PipelineZone phases={sPipeline} />

      <ToastBar toasts={sToasts} onDismiss={handleToastDismiss} />

      <InputArea
        files={sFiles}
        helpOpen={sHelpOpen}
        pending={sPending}
        hasMessages={sHasMessages}
        mode={sMode}
        verbose={sVerbose}
        hasEdits={sHasEdits}
        onSubmit={handleSubmit}
        onPermAllow={allowPermission}
        onPermAlwaysAllow={allowPermissionAlways}
        onPermDeny={dismissPending}
        onApplyFix={applyFix}
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
  const path = await import('node:path');
  const isReset = args?.includes('--reset') ?? false;

  const configDir = path.join(cwd, '.minimum');
  const configPath = path.join(configDir, 'config.json');

  if (!isReset) {
    try {
      await fs.access(configPath);
      dispatch({ type: 'toast.show', text: '.minimum/config.json already exists. Use /init --reset to reinitialize.', tone: 'warn', ttlMs: 5000 });
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

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  dispatch({ type: 'toast.show', text: '/init complete — .minimum/config.json created', tone: 'ok', ttlMs: 5000 });
  dispatch({ type: 'system.push', text: `Project type: ${projectType}`, tone: 'info' });
  dispatch({ type: 'system.push', text: `API: ${isTokenPlan ? 'Token Plan' : 'Pay-as-you-go'} · ${baseUrl}`, tone: 'info' });
  dispatch({ type: 'system.push', text: `Model: mimo-v2.5-pro · 1M ctx · 131k out`, tone: 'info' });
  dispatch({ type: 'system.push', text: `Config: ${configPath}`, tone: 'info' });
}
