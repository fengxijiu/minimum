import React, { useState, useMemo, useEffect } from 'react';
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
import type { AppState, Message, FileEntry, SessionState, Chip, PlanStep } from './types.js';

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

/** Best-effort extract a file path from the tool args JSON-ish string. */
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

export function App({
  runner = mockRunner,
  engineInfo = DEFAULT_ENGINE_INFO,
}: { runner?: Runner; engineInfo?: EngineInfo } = {}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 40;
  const [state, setState] = useState<AppState>(initialState);
  const [input, setInput] = useState('');
  const [sel, setSel] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [activePerm, setActivePerm] = useState<ActivePermission | null>(null);
  const [history] = useState<string[]>(() => loadHistory().map(h => h.text));
  // -1 means "live input"; 0..N indexes into history newest-last
  const [histIdx, setHistIdx] = useState(-1);
  const [savedDraft, setSavedDraft] = useState('');

  useEffect(() => {
    const root = process.cwd();
    const scanned = scanFiles(root);
    const branch = readBranch(root);
    const displayPath = root.replace(process.env.HOME ?? '', '~');
    setState(s => ({
      ...s,
      path: displayPath,
      branch,
      files: scanned.length ? scanned : s.files,
    }));
    if (engineInfo.mode === 'mock') {
      const reason = engineInfo.reason ?? 'not-built';
      const detail = reason === 'no-api-key'
        ? `no MIMO_API_KEY — set env or write ${engineInfo.configPath ?? '~/.minimum/config.json'}`
        : reason === 'not-built'
        ? 'engine bundle missing — run `npm run build` in the repo root'
        : `engine init failed${engineInfo.error ? ` — ${engineInfo.error}` : ''}`;
      setState(s => ({
        ...s,
        messages: [sysMessage(`mock mode · ${detail}`, 'warn'), ...s.messages],
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const atToken = activeAtToken(state.input);
  const overlay: Overlay = state.input.startsWith('/')
    ? 'cmd'
    : atToken !== null ? 'file' : 'none';

  const cmdItems = useMemo(
    () => (overlay === 'cmd' ? filterCommands(state.input) : []),
    [overlay, state.input],
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

  const statusState: SessionState =
    state.pending === 'permission' ? 'paused'
    : state.pending === 'error' ? 'error'
    : state.mode === 'agent' ? 'agent' : 'mimo';

  const titleMode =
    state.pending === 'permission' ? 'agent · paused'
    : state.pending === 'error' ? 'agent · interrupted'
    : state.mode;

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
        setState(s => ({
          ...s,
          ...o.patch,
          messages: o.note
            ? [...(o.patch.messages ?? s.messages), sysMessage(o.note, o.tone)]
            : (o.patch.messages ?? s.messages),
        }));
        return;
    }
  };

  const allowPermission = () => {
    if (activePerm) {
      runner.resolvePermission?.(activePerm.id, { approved: true, reason: 'user approved' });
      setActivePerm(null);
      setPending(null);
      push(sysMessage(`Allowed ${activePerm.tool}.`, 'ok'));
      return;
    }
    setPending('error');
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
  };

  const applyFix = () => {
    setPending(null);
    setState(s => ({ ...s, redo: [] }));
    push(
      { id: mid('t'), type: 'tool', tool: { kind: 'edit', args: 'routes.py · up → uptime', meta: '+1 −1', status: 'ok' } },
      { id: mid('t'), type: 'tool', tool: { kind: 'run', args: 'pytest -q', meta: 'exit 0 · 2.1s', status: 'ok' } },
      { id: mid('a'), type: 'assistant', text: 'Fixed and re-ran — 25 passed. Plan complete.' },
    );
  };

  const dismissPending = (note: string) => {
    if (activePerm) {
      runner.resolvePermission?.(activePerm.id, { approved: false, reason: 'user denied' });
      setActivePerm(null);
    }
    setPending(null);
    push(sysMessage(note, 'warn'));
  };

  const changeInput = (v: string) => {
    if (v === '?' && input === '') { setHelpOpen(true); return; }
    setInput(v);
    setSel(0);
    // Any free-form typing exits history navigation.
    if (histIdx !== -1) setHistIdx(-1);
  };

  const stepHistory = (dir: -1 | 1): boolean => {
    if (!history.length) return false;
    if (histIdx === -1) {
      if (dir === 1) return false;  // already at live edge, ↓ is no-op
      setSavedDraft(input);
      const next = history.length - 1;
      setHistIdx(next);
      setInput(history[next]!);
      return true;
    }
    const next = histIdx + dir;
    if (next < 0) { setInput(history[0]!); setHistIdx(0); return true; }
    if (next >= history.length) {
      setHistIdx(-1);
      setInput(savedDraft);
      return true;
    }
    setInput(history[next]!);
    setHistIdx(next);
    return true;
  };

  const completeCommand = () => {
    const c = cmdItems[clampedSel];
    if (c) dispatch({ type: 'input.change', value: '/' + c.name + ' ' });
  };
  const completeFile = () => {
    const f = fileItems[clampedSel];
    if (!f) return;
    const next = state.input.replace(/(?:^|\s)@[^\s]*$/, (m) =>
      (m.startsWith(' ') ? ' ' : '') + '@' + f.name + ' ');
    dispatch({ type: 'input.change', value: next });
  };

  const handleSubmit = (text: string) => {
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

    push({ id: mid('u'), type: 'user', text: trimmed });
    appendHistory(trimmed);
    history.push(trimmed);
    setHistIdx(-1);
    setSavedDraft('');
    changeInput('');

    void (async () => {
      try {
        for await (const ev of runner.send(trimmed)) {
          if (ev.kind === 'permission_request') {
            const args = ev.args;
            const cmd = String((args as any).command ?? (args as any).path ?? ev.tool);
            setActivePerm({ id: ev.id, tool: ev.tool, args, risk: ev.risk, description: ev.description });
            setPending('permission');
            push({
              id: mid('p'),
              type: 'permission',
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
              setState(s => ({ ...s, files: touch(s.files, { name: fname, meta: ev.name }) }));
            }
          }
          if (ev.kind === 'usage') {
            const used = Number((ev.totalTokens / 1000).toFixed(1));
            setState(s => ({ ...s, ctx: { ...s.ctx, used } }));
            continue;
          }
          if (ev.kind === 'plan') {
            const steps: PlanStep[] = ev.steps.map(st => ({ label: st.label, status: PLAN_STATUS[st.status] }));
            const inProgress = ev.steps.find(st => st.status === 'in_progress');
            const idx = inProgress
              ? ev.steps.indexOf(inProgress) + 1
              : ev.steps.filter(st => st.status === 'completed').length + 1;
            setState(s => ({
              ...s,
              plan: { title: s.plan.title === '(no plan yet)' ? 'agent plan' : s.plan.title, steps },
              currentStepLabel: inProgress ? `STEP ${idx} · ${inProgress.label.toUpperCase()}` : s.currentStepLabel,
            }));
            continue;
          }
          const msgs = uiEventToMessages(ev);
          if (msgs.length) push(...msgs);
        }
      } catch (err: any) {
        dispatch({ type: 'error.push', title: 'runner error', lines: [String(err?.message ?? err)] });
      } finally {
        dispatch({ type: 'turn.end', success: true });
      }
    })();
  };

  const handleToastDismiss = useCallback((id: string) => {
    dispatch({ type: 'toast.dismiss', id });
  }, [dispatch]);

  useInput((input, key) => {
    if (state.helpOpen) {
      if (key.escape || key.return) dispatch({ type: 'help.toggle' });
      return;
    }

    // Ctrl+D = quit
    if (key.ctrl && input === 'd') { exit(); return; }

    // Ctrl+R = verbose toggle
    if (key.ctrl && input === 'r') {
      dispatch({ type: 'verbose.toggle' });
      dispatch({ type: 'toast.show', text: state.verbose ? 'Verbose off' : 'Verbose on', tone: 'info', ttlMs: 2000 });
      return;
    }

    // Ctrl+U = clear input
    if (key.ctrl && input === 'u') {
      setStash(state.input);
      dispatch({ type: 'input.change', value: '' });
      return;
    }

    // Alt+S = stash/recall
    if (key.meta && input === 's') {
      if (stash) {
        const prev = state.input;
        dispatch({ type: 'input.change', value: stash });
        setStash(prev);
      } else if (state.input) {
        setStash(state.input);
        dispatch({ type: 'input.change', value: '' });
      }
      return;
    }

    // Shift+Tab = cycle edit mode (review → auto → yolo)
    if (key.shift && key.tab) {
      const modes = ['review', 'auto', 'yolo'] as const;
      const idx = modes.indexOf(state.editMode);
      const next = modes[(idx + 1) % modes.length]!;
      dispatch({ type: 'edit.mode.change', mode: next });
      dispatch({ type: 'toast.show', text: `Edit mode: ${next}`, tone: 'info', ttlMs: 2000 });
      return;
    }

    // u = undo last edit (when input is empty and not in overlay)
    if (input === 'u' && !state.input && overlay === 'none' && state.edits.length > 0) {
      dispatch({ type: 'edit.undo' });
      return;
    }

    // Ctrl+P / Ctrl+N = prompt history
    if (key.ctrl && input === 'p') {
      const hist = promptHistoryRef.current;
      if (hist.length === 0) return;
      const idx = Math.min(historyIdxRef.current + 1, hist.length - 1);
      historyIdxRef.current = idx;
      dispatch({ type: 'input.change', value: hist[idx]! });
      return;
    }
    if (key.ctrl && input === 'n') {
      const idx = Math.max(historyIdxRef.current - 1, -1);
      historyIdxRef.current = idx;
      dispatch({ type: 'input.change', value: idx >= 0 ? promptHistoryRef.current[idx]! : '' });
      return;
    }

    if (key.escape) {
      if (state.pending) dismissPending(state.pending === 'permission' ? 'Permission denied.' : 'Left as-is.');
      else if (state.input.length) dispatch({ type: 'input.change', value: '' });
      else exit();
      return;
    }
    if (overlay !== 'none' && itemCount) {
      if (key.downArrow) { setSel(s => (s + 1) % itemCount); return; }
      if (key.upArrow)   { setSel(s => (s - 1 + itemCount) % itemCount); return; }
    }
    if (overlay === 'none' && !pending) {
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

  const placeholder =
    state.pending === 'permission' ? 'agent paused — ⏎ to allow, or type to redirect'
    : state.pending === 'error' ? 'redirect, or ⏎ to accept the fix'
    : overlay === 'cmd' ? 'filter commands…'
    : overlay === 'file' ? 'filter files…'
    : !state.messages.some(m => m.type !== 'system') ? 'how can I help?'
    : 'ask, steer, /cmd, @file…  (? for help)';

  const hasConversation = state.messages.some(m => m.type !== 'system');
  const showWelcome = !hasConversation && !state.helpOpen && overlay === 'none';

  return (
    <Box flexDirection="column" height={termRows}>
      <TitleBar path={state.path} branch={state.branch} mode={titleMode} />
      <PlanStrip title={state.plan.title} steps={state.plan.steps} />
      <Box flexDirection="row" flexGrow={1}>
        <ContextRail files={state.files} edits={state.edits} mode={state.mode} />
        <Box flexDirection="column" flexGrow={1}>
          {showWelcome
            ? <WelcomeScreen path={state.path} engine={engineInfo} />
            : <ChatStream stepLabel={state.currentStepLabel} messages={state.messages} />}

          {state.activeTool ? <ToolProgress tool={state.activeTool} /> : null}
          <ToastBar toasts={state.toasts} onDismiss={handleToastDismiss} />

          {state.helpOpen ? <HelpOverlay /> : null}
          {!state.helpOpen && overlay === 'cmd' ? <CommandPalette items={cmdItems} selected={clampedSel} /> : null}
          {!state.helpOpen && overlay === 'file' ? <FilePicker items={fileItems} selected={clampedSel} /> : null}

          <Prompt
            value={state.input}
            onChange={(v) => {
              if (v === '?' && state.input === '') { dispatch({ type: 'help.toggle' }); return; }
              dispatch({ type: 'input.change', value: v });
              setSel(0);
            }}
            onSubmit={handleSubmit}
            placeholder={placeholder}
            focus={!state.helpOpen}
          />
        </Box>
      </Box>
      <StatusBar
        state={statusState}
        approvalMode={state.approvalMode}
        editMode={state.editMode}
        ctxUsed={state.ctx.used}
        ctxMax={state.ctx.max}
        hint={`${state.edits.length} staged · ${state.branch}`}
        usage={state.usage}
        mcpLoading={state.mcpLoading}
      />
    </Box>
  );
}

/**
 * /init handler — non-interactive setup.
 * Detects project type, writes .mimo/config.json with defaults.
 * Uses InitCommand.executeFromArgs() to avoid readline conflicts with ink's raw stdin.
 */
async function runInit(cwd: string, dispatch: Dispatch, args?: string[]) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const isReset = args?.includes('--reset') ?? false;

  // Check if opencode.json already exists (InitCommand's target).
  const opencodePath = path.join(cwd, 'opencode.json');
  if (!isReset) {
    try {
      await fs.access(opencodePath);
      dispatch({ type: 'toast.show', text: 'opencode.json already exists. Use /init --reset to reinitialize.', tone: 'warn', ttlMs: 5000 });
      return;
    } catch { /* good — doesn't exist yet */ }
  }

  // Check for MIMO_API_KEY.
  const apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) {
    dispatch({ type: 'system.push', text: 'MIMO_API_KEY not set. Set it and retry:', tone: 'warn' });
    dispatch({ type: 'system.push', text: '  export MIMO_API_KEY="sk-xxxxx"  (or tp-xxxxx for Token Plan)', tone: 'info' });
    dispatch({ type: 'system.push', text: 'Get your key at: https://platform.xiaomimimo.com/#/console/api-keys', tone: 'info' });
    dispatch({ type: 'toast.show', text: '/init needs MIMO_API_KEY', tone: 'warn', ttlMs: 5000 });
    return;
  }

  // Detect project type.
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

  // Determine API type from key prefix.
  const isTokenPlan = apiKey.startsWith('tp-');
  const baseUrl = isTokenPlan
    ? 'https://token-plan-cn.xiaomimimo.com/v1'
    : 'https://api.xiaomimimo.com/v1';

  try {
    // Use the non-interactive static method — no readline, no stdin conflict.
    const eng = await import('../../dist/index.js') as any;
    const result = await eng.InitCommand.executeFromArgs(cwd, {
      apiKey,
      apiType: isTokenPlan ? 'token-plan' : 'api',
      model: 'mimo-v2.5-pro',
      baseUrl,
    });

    if (result.success) {
      dispatch({ type: 'toast.show', text: '/init complete — configuration created', tone: 'ok', ttlMs: 5000 });
      // Show summary lines.
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
    // Fallback: write .mimo/config.json directly if InitCommand isn't available.
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

/** Translate one UiEvent into one or more AgentEvents. */
function applyUiEvent(ev: import('./engine.js').UiEvent, dispatch: Dispatch) {
  switch (ev.kind) {
    case 'assistant':
      dispatch({ type: 'assistant.final', text: ev.text });
      break;
    case 'reasoning':
      dispatch({ type: 'system.push', text: ev.text, tone: 'info' });
      break;
    case 'tool':
      dispatch({ type: 'tool.start', id: 't' + Date.now(), name: ev.name, args: ev.args });
      break;
    case 'tool_result':
      if (ev.ok) {
        if (ev.content) {
          dispatch({ type: 'system.push', text: ev.content.slice(0, 200), tone: 'ok' });
        }
      } else {
        dispatch({ type: 'error.push', title: ev.name + ' failed', lines: ev.content.split('\n').slice(0, 6) });
      }
      break;
    case 'notice':
      dispatch({ type: 'system.push', text: ev.text, tone: ev.tone });
      break;
    case 'error':
      dispatch({ type: 'error.push', title: 'error', lines: [ev.text] });
      break;
    case 'streaming':
      dispatch({ type: 'assistant.chunk', text: ev.text });
      break;
    case 'streaming_reasoning':
      dispatch({ type: 'system.push', text: ev.text, tone: 'info' });
      break;
    case 'streaming_start':
      dispatch({ type: 'turn.start' });
      break;
    case 'streaming_end':
      break;
    case 'done':
      break;
  }
}
