import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Box, useApp, useStdout } from 'ink';
import { TitleBar }       from './components/TitleBar.js';
import { PlanStrip }      from './components/PlanStrip.js';
import { PipelinePanel }  from './components/PipelinePanel.js';
import { ContextRail }    from './components/ContextRail.js';
import { ChatStream }     from './components/ChatStream.js';
import { StatusBar }      from './components/StatusBar.js';
import { WelcomeScreen }  from './components/WelcomeScreen.js';
import { ToolProgress }   from './components/ToolProgress.js';
import { ToastBar }       from './components/ToastBar.js';
import { InputArea }      from './components/InputArea.js';
import { createInitialState } from './seed.js';
import {
  runCommand, type CommandOutcome, type CommandContext,
} from './commands.js';
import { mockRunner, uiEventToMessages, type Runner, type EngineInfo, type UiPlanStatus } from './engine.js';
import { scanFiles, readBranch, touch } from './files.js';
import { useAgentStore, useSlice, type Dispatch } from './state/store.js';
import type { AppState, Message, FileEntry, SessionState, Chip, PlanStep, PendingState, ApprovalMode, EditMode, UsageInfo, Mode, StagedEdit } from './types.js';

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
  pipelineRunner,
  engineInfo = DEFAULT_ENGINE_INFO,
}: { runner?: Runner; pipelineRunner?: Runner; engineInfo?: EngineInfo } = {}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 40;
  const [state, dispatch] = useAgentStore(() => createInitialState(process.cwd()));
  const [activePerm, setActivePerm] = useState<ActivePermission | null>(null);
  // Mutable refs so callbacks that close over these stay stable
  const stateRef = useRef(state);
  stateRef.current = state;
  const activePermRef = useRef(activePerm);
  activePermRef.current = activePerm;

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
  }, [exit, dispatch, runner]);

  const allowPermission = useCallback(() => {
    const perm = activePermRef.current;
    if (perm) {
      runner.resolvePermission?.(perm.id, { approved: true, reason: 'user approved' });
      setActivePerm(null);
      dispatch({ type: 'pending.clear' });
      dispatch({ type: 'system.push', text: `Allowed ${perm.tool}.`, tone: 'ok' });
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
  }, [runner, dispatch]);

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
  const W_PHASES = useMemo(() => new Set(['W0', 'W1', 'W0.5', 'W2/3', 'W4']), []);
  const runTurn = useCallback((activeRunner: Runner, trimmed: string, isPipeline: boolean) => {
    void (async () => {
      startChunkFlusher();
      if (isPipeline) dispatch({ type: 'pipeline.start' });
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
                note: `${ev.description} · risk ${ev.risk} — ⏎ allow · esc deny`,
              },
            });
            continue;
          }
          if (ev.kind === 'tool') {
            const fname = extractFileArg(ev.args);
            if (fname) {
              dispatch({ type: 'files.set', files: touch(stateRef.current.files, { name: fname, meta: ev.name }) });
            }
          }
          if (ev.kind === 'usage') {
            dispatch({ type: 'ctx.update', used: Number((ev.totalTokens / 1000).toFixed(1)) });
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
        if (isPipeline) dispatch({ type: 'pipeline.end' });
        dispatch({ type: 'turn.end', success: true });
      }
    })();
  }, [dispatch, startChunkFlusher, stopChunkFlusher, W_PHASES]);

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
      applyOutcome(outcome);
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) return;
    if (st.pending) dispatch({ type: 'pending.clear' });

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
  const sVerbose = useSlice(state, s => s.verbose);
  const sHasEdits = useSlice(state, s => s.edits.length > 0);
  const sHasMessages = useMemo(
    () => sMessages.some(m => m.type !== 'system'),
    [sMessages],
  );

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
      <PipelineZone phases={sPipeline} />
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

          <InputArea
            files={sFiles}
            helpOpen={sHelpOpen}
            pending={sPending}
            hasMessages={sHasMessages}
            mode={sMode}
            editMode={sEditMode}
            verbose={sVerbose}
            hasEdits={sHasEdits}
            onSubmit={handleSubmit}
            onPermAllow={allowPermission}
            onPermDeny={dismissPending}
            onApplyFix={applyFix}
            dispatch={dispatch}
            cmdCtx={cmdCtx}
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
