import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Box, useApp, useInput, useStdout } from 'ink';
import { TitleBar }       from './components/TitleBar.js';
import { PlanStrip }      from './components/PlanStrip.js';
import { ContextRail }    from './components/ContextRail.js';
import { ChatStream }     from './components/ChatStream.js';
import { Prompt }         from './components/Prompt.js';
import { StatusBar }      from './components/StatusBar.js';
import { CommandPalette } from './components/CommandPalette.js';
import { FilePicker }     from './components/FilePicker.js';
import { HelpOverlay }    from './components/HelpOverlay.js';
import { WelcomeScreen }  from './components/WelcomeScreen.js';
import { ToolProgress }   from './components/ToolProgress.js';
import { ToastBar }       from './components/ToastBar.js';
import { createInitialState } from './seed.js';
import {
  filterCommands, runCommand, sysMessage, type CommandOutcome, type CommandContext,
} from './commands.js';
import { mockRunner, uiEventToMessages, type Runner, type EngineInfo, type UiPlanStatus } from './engine.js';
import { loadHistory, appendHistory } from './inputHistory.js';
import { scanFiles, readBranch, touch } from './files.js';
import { useAgentStore, useSlice, type Dispatch } from './state/store.js';
import type { AppState, Message, FileEntry, SessionState, Chip, PlanStep, PendingState, ApprovalMode, EditMode, UsageInfo, Mode } from './types.js';

const PLAN_STATUS: Record<UiPlanStatus, PlanStep['status']> = {
  pending: 'next',
  in_progress: 'now',
  completed: 'done',
};

type Overlay = 'none' | 'cmd' | 'file';

interface ActivePermission {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  risk: 'low' | 'medium' | 'high';
  description: string;
}

let seq = 0;
const tid = () => 't' + Date.now() + '_' + seq++;

function activeAtToken(input: string): string | null {
  const m = input.match(/(?:^|\s)@([^\s]*)$/);
  return m ? (m[1] ?? '') : null;
}

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

/** ContextRail zone — only re-renders on files/edits/mode changes. */
const ContextZone = React.memo(function ContextZone({ files, edits, mode }: {
  files: FileEntry[]; edits: AppState['edits']; mode: Mode;
}) {
  return <ContextRail files={files} edits={edits} mode={mode} />;
});

/** ChatStream zone — only re-renders on messages/stepLabel/activeTool/streaming changes. */
const ChatZone = React.memo(function ChatZone({ messages, path, engineInfo, stepLabel, activeTool, helpOpen, streaming }: {
  messages: Message[]; path: string; engineInfo: EngineInfo;
  stepLabel: string; activeTool: AppState['activeTool']; helpOpen: boolean;
  streaming?: string | null;
}) {
  const hasConversation = messages.some(m => m.type !== 'system');
  const showWelcome = !hasConversation && !helpOpen;
  return (
    <>
      {showWelcome
        ? <WelcomeScreen path={path} engine={engineInfo} />
        : <ChatStream stepLabel={stepLabel} messages={messages} streaming={streaming} />}
      {activeTool ? <ToolProgress tool={activeTool} /> : null}
    </>
  );
});

/** StatusBar zone — only re-renders on status/usage changes. */
const StatusZone = React.memo(function StatusZone({
  statusState, approvalMode, editMode, ctxUsed, ctxMax, hint, usage, mcpLoading,
}: {
  statusState: SessionState; approvalMode?: ApprovalMode; editMode?: EditMode;
  ctxUsed: number; ctxMax: number; hint: string; usage: UsageInfo; mcpLoading: AppState['mcpLoading'];
}) {
  return (
    <StatusBar
      state={statusState}
      approvalMode={approvalMode}
      editMode={editMode}
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
  engineInfo = DEFAULT_ENGINE_INFO,
}: { runner?: Runner; engineInfo?: EngineInfo } = {}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 40;
  const [state, dispatch] = useAgentStore(() => createInitialState(process.cwd()));
  const [sel, setSel] = useState(0);
  const [activePerm, setActivePerm] = useState<ActivePermission | null>(null);
  const [history] = useState<string[]>(() => loadHistory().map(h => h.text));
  const [histIdx, setHistIdx] = useState(-1);
  const [savedDraft, setSavedDraft] = useState('');
  const [stash, setStash] = useState('');
  const promptHistoryRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);

  // ── Streaming chunk buffer (50ms flush) ─────────────────────────────
  const chunkBufferRef = useRef('');
  const chunkFlushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flushChunks = useCallback(() => {
    if (chunkBufferRef.current) {
      dispatch({ type: 'assistant.chunk', text: chunkBufferRef.current });
      chunkBufferRef.current = '';
    }
  }, [dispatch]);
  const startChunkFlusher = useCallback(() => {
    if (chunkFlushTimerRef.current) return;
    chunkFlushTimerRef.current = setInterval(flushChunks, 100);
  }, [flushChunks]);
  const stopChunkFlusher = useCallback(() => {
    if (chunkFlushTimerRef.current) {
      clearInterval(chunkFlushTimerRef.current);
      chunkFlushTimerRef.current = null;
    }
    flushChunks();
  }, [flushChunks]);

  // ── Input (local state, not in reducer) ─────────────────────────────
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef(inputValue);
  const immediateInputChange = useCallback((v: string) => {
    inputRef.current = v;
    setInputValue(v);
  }, []);

  // ── Init ────────────────────────────────────────────────────────────
  useEffect(() => {
    const root = process.cwd();
    const scanned = scanFiles(root);
    immediateInputChange('');
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

  // ── Overlay detection (reads buffer, not state, for zero-lag) ───────
  const liveInput = inputRef.current;
  const atToken = activeAtToken(liveInput);
  const overlay: Overlay = liveInput.startsWith('/')
    ? 'cmd'
    : atToken !== null ? 'file' : 'none';

  const cmdItems = useMemo(
    () => (overlay === 'cmd' ? filterCommands(liveInput) : []),
    [overlay, liveInput],
  );

  const cmdCtx: CommandContext = useMemo(() => ({
    model: engineInfo.model,
    tools: engineInfo.tools,
    configPath: engineInfo.configPath,
    memoryPath: engineInfo.memoryPath,
    baseUrl: engineInfo.baseUrl,
    engineMode: engineInfo.mode,
  }), [engineInfo]);
  const fileItems = useMemo<FileEntry[]>(() => {
    if (overlay !== 'file') return [];
    const q = (atToken ?? '').toLowerCase();
    return state.files.filter(f => f.name.toLowerCase().includes(q));
  }, [overlay, atToken, state.files]);

  const itemCount = overlay === 'cmd' ? cmdItems.length : overlay === 'file' ? fileItems.length : 0;
  const clampedSel = itemCount ? Math.min(sel, itemCount - 1) : 0;

  // ── Command / permission handlers ───────────────────────────────────
  const applyOutcome = (o: CommandOutcome) => {
    switch (o.kind) {
      case 'quit': exit(); return;
      case 'help': dispatch({ type: 'help.toggle' }); return;
      case 'note': dispatch({ type: 'system.push', text: o.note, tone: o.tone }); return;
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
        if (o.patch.editMode) dispatch({ type: 'edit.mode.change', mode: o.patch.editMode });
        if (o.note) dispatch({ type: 'system.push', text: o.note, tone: o.tone });
        return;
    }
  };

  const allowPermission = useCallback(() => {
    if (activePerm) {
      runner.resolvePermission?.(activePerm.id, { approved: true, reason: 'user approved' });
      setActivePerm(null);
      dispatch({ type: 'pending.clear' });
      dispatch({ type: 'system.push', text: `Allowed ${activePerm.tool}.`, tone: 'ok' });
      return;
    }
    dispatch({ type: 'pending.set', value: 'error' });
    const chips: Chip[] = [
      { key: '⏎', label: 'fix & re-run', primary: true },
      { key: 'n', label: 'leave it' },
      { key: 'u', label: 'undo last edit' },
      { key: 'l', label: 'show full log' },
    ];
    const id1 = tid();
    dispatch({ type: 'tool.start', id: id1, name: 'exec_shell', args: 'pytest -q' });
    dispatch({ type: 'tool.end', id: id1, ok: false, meta: 'exit 1 · 2.3s' });
    dispatch({ type: 'error.push', title: 'STDERR · 1 FAILURE', lines: [
      'FAILED tests/test_routes.py::test_health',
      "  AssertionError: 'uptime' not in response",
      "  expected key 'uptime', got ['up','sha']",
      '====== 1 failed, 24 passed in 2.31s ======',
    ]});
    dispatch({ type: 'assistant.final', text: "My handler returns 'up', but the test expects 'uptime'. I'll rename the key in routes.py." });
    dispatch({ type: 'chips.push', chips });
  }, [activePerm, runner, dispatch]);

  const applyFix = useCallback(() => {
    dispatch({ type: 'pending.clear' });
    dispatch({ type: 'edits.clear' });
    const mid = (p: string) => p + Date.now() + '_' + seq++;
    dispatch({ type: 'tool.start', id: mid('t'), name: 'edit', args: 'routes.py · up → uptime' });
    dispatch({ type: 'tool.end', id: mid('t'), ok: true, meta: '+1 −1' });
    dispatch({ type: 'tool.start', id: mid('t'), name: 'run', args: 'pytest -q' });
    dispatch({ type: 'tool.end', id: mid('t'), ok: true, meta: 'exit 0 · 2.1s' });
    dispatch({ type: 'assistant.final', text: 'Fixed and re-ran — 25 passed. Plan complete.' });
  }, [dispatch]);

  const dismissPending = useCallback((note: string) => {
    if (activePerm) {
      runner.resolvePermission?.(activePerm.id, { approved: false, reason: 'user denied' });
      setActivePerm(null);
    }
    dispatch({ type: 'pending.clear' });
    dispatch({ type: 'system.push', text: note, tone: 'warn' });
  }, [activePerm, runner, dispatch]);

  const changeInput = useCallback((v: string) => {
    if (v === '?' && inputValue === '') { dispatch({ type: 'help.toggle' }); return; }
    immediateInputChange(v);
    setSel(0);
    if (histIdx !== -1) setHistIdx(-1);
  }, [inputValue, dispatch, histIdx, immediateInputChange]);

  // ── History navigation ──────────────────────────────────────────────
  const stepHistory = (dir: -1 | 1): boolean => {
    if (!history.length) return false;
    if (histIdx === -1) {
      if (dir === 1) return false;
      setSavedDraft(inputValue);
      const next = history.length - 1;
      setHistIdx(next);
      immediateInputChange(history[next]!);
      return true;
    }
    const next = histIdx + dir;
    if (next < 0) { immediateInputChange(history[0]!); setHistIdx(0); return true; }
    if (next >= history.length) {
      setHistIdx(-1);
      immediateInputChange(savedDraft);
      return true;
    }
    immediateInputChange(history[next]!);
    setHistIdx(next);
    return true;
  };

  const completeCommand = () => {
    const c = cmdItems[clampedSel];
    if (c) immediateInputChange('/' + c.name + ' ');
  };
  const completeFile = () => {
    const f = fileItems[clampedSel];
    if (!f) return;
    const next = inputValue.replace(/(?:^|\s)@[^\s]*$/, (m) =>
      (m.startsWith(' ') ? ' ' : '') + '@' + f.name + ' ');
    immediateInputChange(next);
  };

  // ── Submit handler ──────────────────────────────────────────────────
  const handleSubmit = useCallback((text: string) => {
    if (state.helpOpen) return;

    if (!text.trim() && state.pending === 'permission') { allowPermission(); return; }
    if (!text.trim() && state.pending === 'error') { applyFix(); return; }

    if (overlay === 'cmd') {
      const c = cmdItems[clampedSel];
      applyOutcome(runCommand(c ? '/' + c.name + ' ' + text.replace(/^\/\S*\s*/, '') : text, state, cmdCtx));
      changeInput('');
      return;
    }
    if (overlay === 'file') { completeFile(); return; }

    const trimmed = text.trim();
    if (!trimmed) return;
    if (state.pending) dispatch({ type: 'pending.clear' });

    dispatch({ type: 'user.submit', text: trimmed });
    appendHistory(trimmed);
    promptHistoryRef.current.push(trimmed);
    historyIdxRef.current = -1;
    setHistIdx(-1);
    setSavedDraft('');
    changeInput('');

    void (async () => {
      startChunkFlusher();
      try {
        for await (const ev of runner.send(trimmed)) {
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
                cwd: state.path,
                note: `${ev.description} · risk ${ev.risk} — ⏎ allow · esc deny`,
              },
            });
            continue;
          }
          if (ev.kind === 'tool') {
            const fname = extractFileArg(ev.args);
            if (fname) {
              dispatch({ type: 'files.set', files: touch(state.files, { name: fname, meta: ev.name }) });
            }
          }
          if (ev.kind === 'usage') {
            const used = Number((ev.totalTokens / 1000).toFixed(1));
            dispatch({ type: 'ctx.update', used });
            continue;
          }
          if (ev.kind === 'plan') {
            const steps: PlanStep[] = ev.steps.map(st => ({ label: st.label, status: PLAN_STATUS[st.status] }));
            const inProgress = ev.steps.find(st => st.status === 'in_progress');
            const idx = inProgress
              ? ev.steps.indexOf(inProgress) + 1
              : ev.steps.filter(st => st.status === 'completed').length + 1;
            dispatch({
              type: 'plan.set',
              title: state.plan.title === '(no plan yet)' ? 'agent plan' : state.plan.title,
              steps,
            });
            if (inProgress) {
              dispatch({ type: 'system.push', text: `STEP ${idx} · ${inProgress.label.toUpperCase()}`, tone: 'info' });
            }
            continue;
          }
          // Buffer streaming chunks
          if (ev.kind === 'streaming') {
            chunkBufferRef.current += ev.text;
            continue;
          }

          const msgs = uiEventToMessages(ev);
          for (const msg of msgs) {
            if (msg.type === 'system') dispatch({ type: 'system.push', text: msg.text, tone: msg.tone });
            else if (msg.type === 'assistant') dispatch({ type: 'assistant.final', text: msg.text });
            else if (msg.type === 'error') dispatch({ type: 'error.push', title: msg.error.title, lines: msg.error.lines });
            else if (msg.type === 'tool') dispatch({ type: 'tool.start', id: msg.id, name: msg.tool.kind, args: msg.tool.args });
          }
        }
      } catch (err: any) {
        dispatch({ type: 'error.push', title: 'runner error', lines: [String(err?.message ?? err)] });
      } finally {
        stopChunkFlusher();
        dispatch({ type: 'turn.end', success: true });
      }
    })();
  }, [state.helpOpen, state.pending, overlay, cmdItems, clampedSel, state, cmdCtx, runner, dispatch, startChunkFlusher, stopChunkFlusher, allowPermission, applyFix, changeInput]);

  const handleToastDismiss = useCallback((id: string) => {
    dispatch({ type: 'toast.dismiss', id });
  }, [dispatch]);

  // ── Keyboard handler ────────────────────────────────────────────────
  useInput((input, key) => {
    if (state.helpOpen) {
      if (key.escape || key.return) dispatch({ type: 'help.toggle' });
      return;
    }

    if (key.ctrl && input === 'd') { exit(); return; }

    if (key.ctrl && input === 'r') {
      dispatch({ type: 'verbose.toggle' });
      dispatch({ type: 'toast.show', text: state.verbose ? 'Verbose off' : 'Verbose on', tone: 'info', ttlMs: 2000 });
      return;
    }

    if (key.ctrl && input === 'u') {
      setStash(inputValue);
      immediateInputChange('');
      return;
    }

    if (key.meta && input === 's') {
      if (stash) {
        const prev = inputValue;
        immediateInputChange(stash);
        setStash(prev);
      } else if (inputValue) {
        setStash(inputValue);
        immediateInputChange('');
      }
      return;
    }

    if (key.shift && key.tab) {
      const modes = ['review', 'auto', 'yolo'] as const;
      const idx = modes.indexOf(state.editMode);
      const next = modes[(idx + 1) % modes.length]!;
      dispatch({ type: 'edit.mode.change', mode: next });
      dispatch({ type: 'toast.show', text: `Edit mode: ${next}`, tone: 'info', ttlMs: 2000 });
      return;
    }

    if (input === 'u' && !inputValue && overlay === 'none' && state.edits.length > 0) {
      dispatch({ type: 'edit.undo' });
      return;
    }

    if (key.ctrl && input === 'p') {
      const hist = promptHistoryRef.current;
      if (hist.length === 0) return;
      const idx = Math.min(historyIdxRef.current + 1, hist.length - 1);
      historyIdxRef.current = idx;
      immediateInputChange(hist[idx]!);
      return;
    }
    if (key.ctrl && input === 'n') {
      const idx = Math.max(historyIdxRef.current - 1, -1);
      historyIdxRef.current = idx;
      immediateInputChange(idx >= 0 ? promptHistoryRef.current[idx]! : '');
      return;
    }

    if (key.escape) {
      if (state.pending) dismissPending(state.pending === 'permission' ? 'Permission denied.' : 'Left as-is.');
      else if (inputValue.length) immediateInputChange('');
      else exit();
      return;
    }
    if (overlay !== 'none' && itemCount) {
      if (key.downArrow) { setSel(s => (s + 1) % itemCount); return; }
      if (key.upArrow)   { setSel(s => (s - 1 + itemCount) % itemCount); return; }
    }
    if (overlay === 'none' && !state.pending) {
      if (key.upArrow)   { if (stepHistory(-1)) return; }
      if (key.downArrow) { if (stepHistory(1)) return; }
    }
    if (key.tab) {
      if (overlay === 'cmd' && cmdItems.length) completeCommand();
      else if (overlay === 'file' && fileItems.length) completeFile();
      else dispatch({ type: 'mode.change', mode: state.mode === 'agent' ? 'chat' : 'agent' });
      return;
    }
  });

  // ── Placeholder text ────────────────────────────────────────────────
  const placeholder =
    state.pending === 'permission' ? 'agent paused — ⏎ to allow, or type to redirect'
    : state.pending === 'error' ? 'redirect, or ⏎ to accept the fix'
    : overlay === 'cmd' ? 'filter commands…'
    : overlay === 'file' ? 'filter files…'
    : liveInput === '' && !state.messages.some(m => m.type !== 'system') ? 'how can I help?'
    : 'ask, steer, /cmd, @file…  (? for help)';

  // ── Extract slices for zone props (input is local, not from state) ─
  const sPath = useSlice(state, s => s.path);
  const sBranch = useSlice(state, s => s.branch);
  const sMode = useSlice(state, s => s.mode);
  const sPending = useSlice(state, s => s.pending);
  const sPlanTitle = useSlice(state, s => s.plan.title);
  const sPlanSteps = useSlice(state, s => s.plan.steps);
  const sFiles = useSlice(state, s => s.files);
  const sEdits = useSlice(state, s => s.edits);
  const sMessages = useSlice(state, s => s.messages);
  const sHelpOpen = useSlice(state, s => s.helpOpen);
  const sStepLabel = useSlice(state, s => s.currentStepLabel);
  const sActiveTool = useSlice(state, s => s.activeTool);
  const sStreaming = useSlice(state, s => s.streaming);
  const sApprovalMode = useSlice(state, s => s.approvalMode);
  const sEditMode = useSlice(state, s => s.editMode);
  const sCtxUsed = useSlice(state, s => s.ctx.used);
  const sCtxMax = useSlice(state, s => s.ctx.max);
  const sUsage = useSlice(state, s => s.usage);
  const sMcpLoading = useSlice(state, s => s.mcpLoading);
  const sToasts = useSlice(state, s => s.toasts);

  const titleMode =
    sPending === 'permission' ? 'agent · paused'
    : sPending === 'error' ? 'agent · interrupted'
    : sMode;
  const statusState: SessionState =
    sPending === 'permission' ? 'paused'
    : sPending === 'error' ? 'error'
    : sMode === 'agent' ? 'agent' : 'mimo';

  // ── Render: zone-based layout ───────────────────────────────────────
  return (
    <Box flexDirection="column" height={termRows}>
      <TitleZone path={sPath} branch={sBranch} mode={titleMode} />
      <PlanZone title={sPlanTitle} steps={sPlanSteps} />
      <Box flexDirection="row" flexGrow={1}>
        <ContextZone files={sFiles} edits={sEdits} mode={sMode} />
        <Box flexDirection="column" flexGrow={1}>
          <ChatZone
            messages={sMessages}
            path={sPath}
            engineInfo={engineInfo}
            stepLabel={sStepLabel}
            activeTool={sActiveTool}
            helpOpen={sHelpOpen}
            streaming={sStreaming}
          />

          <ToastBar toasts={sToasts} onDismiss={handleToastDismiss} />

          {sHelpOpen ? <HelpOverlay /> : null}
          {!sHelpOpen && overlay === 'cmd' ? <CommandPalette items={cmdItems} selected={clampedSel} /> : null}
          {!sHelpOpen && overlay === 'file' ? <FilePicker items={fileItems} selected={clampedSel} /> : null}

          <Prompt
            value={inputValue}
            onChange={(v) => {
              inputRef.current = v;
              if (v === '?' && inputValue === '') { dispatch({ type: 'help.toggle' }); return; }
              immediateInputChange(v);
              setSel(0);
            }}
            onSubmit={handleSubmit}
            placeholder={placeholder}
            focus={!sHelpOpen}
          />
        </Box>
      </Box>
      <StatusZone
        statusState={statusState}
        approvalMode={sApprovalMode}
        editMode={sEditMode}
        ctxUsed={sCtxUsed}
        ctxMax={sCtxMax}
        hint={`${sEdits.length} staged · ${sBranch}`}
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

  const opencodePath = path.join(cwd, 'opencode.json');
  if (!isReset) {
    try {
      await fs.access(opencodePath);
      dispatch({ type: 'toast.show', text: 'opencode.json already exists. Use /init --reset to reinitialize.', tone: 'warn', ttlMs: 5000 });
      return;
    } catch { /* good — doesn't exist yet */ }
  }

  const apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) {
    dispatch({ type: 'system.push', text: 'MIMO_API_KEY not set. Set it and retry:', tone: 'warn' });
    dispatch({ type: 'system.push', text: '  export MIMO_API_KEY="sk-xxxxx"  (or tp-xxxxx for Token Plan)', tone: 'info' });
    dispatch({ type: 'system.push', text: 'Get your key at: https://platform.xiaomimimo.com/#/console/api-keys', tone: 'info' });
    dispatch({ type: 'toast.show', text: '/init needs MIMO_API_KEY', tone: 'warn', ttlMs: 5000 });
    return;
  }

  const markers: Array<{ file: string; type: string }> = [
    { file: 'package.json', type: 'node' },
    { file: 'tsconfig.json', type: 'typescript' },
    { file: 'pyproject.toml', type: 'python' },
    { file: 'Cargo.toml', type: 'rust' },
    { file: 'go.mod', type: 'go' },
    { file: 'pom.xml', type: 'java' },
    { file: 'build.gradle', type: 'java' },
    { file: 'Gemfile', type: 'ruby' },
    { file: 'composer.json', type: 'php' },
  ];

  const detected: string[] = [];
  for (const m of markers) {
    try {
      await fs.access(path.join(cwd, m.file));
      detected.push(m.type);
    } catch { /* not found */ }
  }
  const projectType = detected.length > 0 ? detected[0] : 'unknown';

  const isTokenPlan = apiKey.startsWith('tp-');
  const baseUrl = isTokenPlan
    ? 'https://token-plan-cn.xiaomimimo.com/v1'
    : 'https://api.xiaomimimo.com/v1';

  try {
    const eng = await import('../../dist/index.js') as any;
    const result = await eng.InitCommand.executeFromArgs(cwd, {
      apiKey,
      apiType: isTokenPlan ? 'token-plan' : 'api',
      model: 'mimo-v2.5-pro',
      baseUrl,
    });

    if (result.success) {
      dispatch({ type: 'toast.show', text: '/init complete — configuration created', tone: 'ok', ttlMs: 5000 });
      const lines = [
        `Project type: ${projectType}`,
        `API type: ${isTokenPlan ? 'Token Plan' : 'Pay-as-you-go'}`,
        `Base URL: ${baseUrl}`,
        `Model: mimo-v2.5-pro · 1M ctx · 131k out`,
        `Config: opencode.json + ~/.config/opencode/opencode.json`,
      ];
      for (const line of lines) {
        dispatch({ type: 'system.push', text: line, tone: 'info' });
      }
    } else {
      dispatch({ type: 'error.push', title: '/init failed', lines: [result.output] });
    }
  } catch (err: any) {
    const mimoDir = path.join(cwd, '.mimo');
    const configPath = path.join(mimoDir, 'config.json');
    const config = {
      maxTokens: 131072,
      maxSteps: 50,
      approvalMode: 'suggest',
      enableReadGuard: true,
      context: { foldThreshold: 0.70, aggressiveThreshold: 0.75, tailFraction: 0.25 },
      capacity: { enabled: true, lowRiskMax: 0.50, mediumRiskMax: 0.62 },
      storm: { windowSize: 6, threshold: 3 },
      validation: { enabled: true, syntax: true, tsc: true, pattern: true },
      completeness: { enabled: true },
    };
    await fs.mkdir(mimoDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    dispatch({ type: 'toast.show', text: '/init fallback — .mimo/config.json created', tone: 'ok', ttlMs: 5000 });
    dispatch({ type: 'system.push', text: `Project type: ${projectType}`, tone: 'info' });
    dispatch({ type: 'system.push', text: 'Config: .mimo/config.json (InitCommand unavailable, used defaults)', tone: 'info' });
  }
}
