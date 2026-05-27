import React, { useState, useMemo } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { TitleBar }      from './components/TitleBar.js';
import { PlanStrip }     from './components/PlanStrip.js';
import { ContextRail }   from './components/ContextRail.js';
import { ChatStream }    from './components/ChatStream.js';
import { Prompt }        from './components/Prompt.js';
import { StatusBar }     from './components/StatusBar.js';
import { CommandPalette } from './components/CommandPalette.js';
import { FilePicker }     from './components/FilePicker.js';
import { HelpOverlay }    from './components/HelpOverlay.js';
import { initialState }   from './mock.js';
import {
  filterCommands, runCommand, sysMessage, type CommandOutcome,
} from './commands.js';
import type { AppState, Message, FileEntry } from './types.js';

type Overlay = 'none' | 'cmd' | 'file';

/** Partial after a trailing `@token`, or null if the input isn't in @-mode. */
function activeAtToken(input: string): string | null {
  const m = input.match(/(?:^|\s)@([^\s]*)$/);
  return m ? (m[1] ?? '') : null;
}

export function App() {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>(initialState);
  const [input, setInput] = useState('');
  const [sel, setSel] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);

  // Derive the active overlay + its items purely from the current input.
  const atToken = activeAtToken(input);
  const overlay: Overlay = input.startsWith('/')
    ? 'cmd'
    : atToken !== null ? 'file' : 'none';

  const cmdItems = useMemo(
    () => (overlay === 'cmd' ? filterCommands(input) : []),
    [overlay, input],
  );
  const fileItems = useMemo<FileEntry[]>(() => {
    if (overlay !== 'file') return [];
    const q = (atToken ?? '').toLowerCase();
    return state.files.filter(f => f.name.toLowerCase().includes(q));
  }, [overlay, atToken, state.files]);

  const itemCount = overlay === 'cmd' ? cmdItems.length : overlay === 'file' ? fileItems.length : 0;
  const clampedSel = itemCount ? Math.min(sel, itemCount - 1) : 0;

  const pushMessages = (msgs: Message[]) =>
    setState(s => ({ ...s, messages: [...s.messages, ...msgs] }));

  const applyOutcome = (o: CommandOutcome) => {
    switch (o.kind) {
      case 'quit': exit(); return;
      case 'help': setHelpOpen(true); return;
      case 'note':
        pushMessages([sysMessage(o.note, o.tone)]);
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

  const changeInput = (v: string) => {
    // `?` on an empty prompt opens help instead of typing a literal.
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

    // Command palette → run the selected/typed command.
    if (overlay === 'cmd') {
      const c = cmdItems[clampedSel];
      applyOutcome(runCommand(c ? '/' + c.name + ' ' + text.replace(/^\/\S*\s*/, '') : text, state));
      changeInput('');
      return;
    }

    // File picker → insert the file, keep editing.
    if (overlay === 'file') {
      completeFile();
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) return;

    const now = Date.now();
    const userMsg: Message = { id: 'u' + now, type: 'user', text: trimmed };
    const botMsg: Message = {
      id: 'a' + now,
      type: 'assistant',
      text: '(mock) wire your MiMo stream in src/app.tsx → handleSubmit',
    };
    setState(s => ({ ...s, messages: [...s.messages, userMsg, botMsg] }));
    changeInput('');
  };

  useInput((_in, key) => {
    if (helpOpen) {
      if (key.escape || key.return) setHelpOpen(false);
      return;
    }

    if (key.escape) {
      if (input.length) changeInput('');
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
    overlay === 'cmd' ? 'filter commands…'
    : overlay === 'file' ? 'filter files…'
    : 'ask, steer, /cmd, @file…  (? for help)';

  return (
    <Box flexDirection="column">
      <TitleBar path={state.path} branch={state.branch} mode={state.mode} />
      <PlanStrip title={state.plan.title} steps={state.plan.steps} />
      <Box flexDirection="row">
        <ContextRail files={state.files} edits={state.edits} mode={state.mode} />
        <Box flexDirection="column" flexGrow={1}>
          <ChatStream stepLabel={state.currentStepLabel} messages={state.messages} />

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
        mode={state.mode}
        ctxUsed={state.ctx.used}
        ctxMax={state.ctx.max}
        hint={`${state.edits.length} staged · ${state.branch}`}
      />
    </Box>
  );
}
