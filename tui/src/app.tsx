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
import { initialState }   from './mock.js';
import {
  filterCommands, runCommand, sysMessage, type CommandOutcome, type CommandContext,
} from './commands.js';
import { mockRunner, uiEventToMessages, type Runner, type EngineInfo, type UiPlanStatus } from './engine.js';
import type { AppState, Message, FileEntry, SessionState, Chip, PlanStep } from './types.js';

const PLAN_STATUS: Record<UiPlanStatus, PlanStep['status']> = {
  pending: 'next',
  in_progress: 'now',
  completed: 'done',
};

type Overlay = 'none' | 'cmd' | 'file';
type Pending = null | 'permission' | 'error';

let seq = 0;
const mid = (p: string) => p + Date.now() + '_' + seq++;

function activeAtToken(input: string): string | null {
  const m = input.match(/(?:^|\s)@([^\s]*)$/);
  return m ? (m[1] ?? '') : null;
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

  useEffect(() => {
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

  const atToken = activeAtToken(input);
  const overlay: Overlay = input.startsWith('/')
    ? 'cmd'
    : atToken !== null ? 'file' : 'none';

  const cmdItems = useMemo(
    () => (overlay === 'cmd' ? filterCommands(input) : []),
    [overlay, input],
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
    pending === 'permission' ? 'paused'
    : pending === 'error' ? 'error'
    : state.mode === 'agent' ? 'agent' : 'mimo';

  const titleMode =
    pending === 'permission' ? 'agent · paused'
    : pending === 'error' ? 'agent · interrupted'
    : state.mode;

  const push = (...msgs: Message[]) =>
    setState(s => ({ ...s, messages: [...s.messages, ...msgs] }));

  const applyOutcome = (o: CommandOutcome) => {
    switch (o.kind) {
      case 'quit': exit(); return;
      case 'help': setHelpOpen(true); return;
      case 'note': push(sysMessage(o.note, o.tone)); return;
      case 'permission':
        setPending('permission');
        push({ id: mid('p'), type: 'permission', perm: o.perm });
        return;
      case 'patch':
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

  // permission → run fails → error block + agent's proposed fix (matches design)
  const allowPermission = () => {
    setPending('error');
    const chips: Chip[] = [
      { key: '⏎', label: 'fix & re-run', primary: true },
      { key: 'n', label: 'leave it' },
      { key: 'u', label: 'undo last edit' },
      { key: 'l', label: 'show full log' },
    ];
    push(
      { id: mid('t'), type: 'tool', tool: { kind: 'run', args: 'pytest -q', meta: 'exit 1 · 2.3s', status: 'err' } },
      { id: mid('e'), type: 'error', error: {
        title: 'STDERR · 1 FAILURE',
        lines: [
          'FAILED tests/test_routes.py::test_health',
          "  AssertionError: 'uptime' not in response",
          "  expected key 'uptime', got ['up','sha']",
          '====== 1 failed, 24 passed in 2.31s ======',
        ],
      } },
      { id: mid('a'), type: 'assistant', text: "My handler returns 'up', but the test expects 'uptime'. I'll rename the key in routes.py." },
      { id: mid('c'), type: 'chips', chips },
    );
  };

  const applyFix = () => {
    setPending(null);
    push(
      { id: mid('t'), type: 'tool', tool: { kind: 'edit', args: 'routes.py · up → uptime', meta: '+1 −1', status: 'ok' } },
      { id: mid('t'), type: 'tool', tool: { kind: 'run', args: 'pytest -q', meta: 'exit 0 · 2.1s', status: 'ok' } },
      { id: mid('a'), type: 'assistant', text: 'Fixed and re-ran — 25 passed. Plan complete.' },
    );
  };

  const dismissPending = (note: string) => {
    setPending(null);
    push(sysMessage(note, 'warn'));
  };

  const changeInput = (v: string) => {
    if (v === '?' && input === '') { setHelpOpen(true); return; }
    setInput(v);
    setSel(0);
  };

  const completeCommand = () => {
    const c = cmdItems[clampedSel];
    if (c) changeInput('/' + c.name + ' ');
  };
  const completeFile = () => {
    const f = fileItems[clampedSel];
    if (!f) return;
    const next = input.replace(/(?:^|\s)@[^\s]*$/, (m) =>
      (m.startsWith(' ') ? ' ' : '') + '@' + f.name + ' ');
    changeInput(next);
  };

  const handleSubmit = (text: string) => {
    if (helpOpen) return;

    // Resolve a pending agent prompt with Enter (primary action).
    if (!text.trim() && pending === 'permission') { allowPermission(); return; }
    if (!text.trim() && pending === 'error') { applyFix(); return; }

    if (overlay === 'cmd') {
      const c = cmdItems[clampedSel];
      applyOutcome(runCommand(c ? '/' + c.name + ' ' + text.replace(/^\/\S*\s*/, '') : text, state, cmdCtx));
      changeInput('');
      return;
    }
    if (overlay === 'file') { completeFile(); return; }

    const trimmed = text.trim();
    if (!trimmed) return;
    if (pending) setPending(null); // a typed message redirects the agent

    push({ id: mid('u'), type: 'user', text: trimmed });
    changeInput('');

    // Stream the engine's normalized events into the chat.
    void (async () => {
      try {
        for await (const ev of runner.send(trimmed)) {
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
        push({ id: mid('x'), type: 'error', error: { title: 'runner error', lines: [String(err?.message ?? err)] } });
      }
    })();
  };

  useInput((_in, key) => {
    if (helpOpen) {
      if (key.escape || key.return) setHelpOpen(false);
      return;
    }
    if (key.escape) {
      if (pending) dismissPending(pending === 'permission' ? 'Permission denied.' : 'Left as-is.');
      else if (input.length) changeInput('');
      else exit();
      return;
    }
    if (overlay !== 'none' && itemCount) {
      if (key.downArrow) { setSel(s => (s + 1) % itemCount); return; }
      if (key.upArrow)   { setSel(s => (s - 1 + itemCount) % itemCount); return; }
    }
    if (key.tab) {
      if (overlay === 'cmd' && cmdItems.length) completeCommand();
      else if (overlay === 'file' && fileItems.length) completeFile();
      else setState(s => ({ ...s, mode: s.mode === 'agent' ? 'chat' : 'agent' }));
      return;
    }
  });

  const placeholder =
    pending === 'permission' ? 'agent paused — ⏎ to allow, or type to redirect'
    : pending === 'error' ? 'redirect, or ⏎ to accept the fix'
    : overlay === 'cmd' ? 'filter commands…'
    : overlay === 'file' ? 'filter files…'
    : !state.messages.some(m => m.type !== 'system') ? 'how can I help?'
    : 'ask, steer, /cmd, @file…  (? for help)';

  const hasConversation = state.messages.some(m => m.type !== 'system');
  const showWelcome = !hasConversation && !helpOpen && overlay === 'none';

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

          {helpOpen ? <HelpOverlay /> : null}
          {!helpOpen && overlay === 'cmd' ? <CommandPalette items={cmdItems} selected={clampedSel} /> : null}
          {!helpOpen && overlay === 'file' ? <FilePicker items={fileItems} selected={clampedSel} /> : null}

          <Prompt
            value={input}
            onChange={changeInput}
            onSubmit={handleSubmit}
            placeholder={placeholder}
            focus={!helpOpen}
          />
        </Box>
      </Box>
      <StatusBar
        state={statusState}
        approvalMode={state.approvalMode}
        ctxUsed={state.ctx.used}
        ctxMax={state.ctx.max}
        hint={`${state.edits.length} staged · ${state.branch}`}
      />
    </Box>
  );
}
