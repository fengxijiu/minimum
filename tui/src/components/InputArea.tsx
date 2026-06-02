import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { CommandPalette } from './CommandPalette.js';
import { FilePicker } from './FilePicker.js';
import { HelpOverlay } from './HelpOverlay.js';
import { Prompt } from './Prompt.js';
import { filterCommands, filterFiles, type CommandContext, type CmdMatch, type FileMatch } from '../commands.js';
import { loadHistory, appendHistory } from '../inputHistory.js';
import type { FileEntry, PendingState, Mode, ChoiceRequest } from '../types.js';
import type { Dispatch } from '../state/store.js';
import { theme } from '../theme.js';

type Overlay = 'none' | 'cmd' | 'file';

const PERM_OPTIONS = [
  { label: 'Allow once', tone: 'ok', width: 15 },
  { label: 'Always allow', tone: 'warn', width: 17 },
  { label: 'Deny', tone: 'danger', width: 9 },
] as const;

function PermissionChoiceBar({ selected }: { selected: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={2} paddingY={0}>
      <Text color={theme.warn} bold>permission required</Text>
      <Box marginTop={0}>
        {PERM_OPTIONS.map((opt, i) => {
          const active = i === selected;
          const color =
            opt.tone === 'danger' ? theme.danger
            : opt.tone === 'warn' ? theme.warn
            : theme.accent;
          const label = `${active ? '▶ ' : '  '}${opt.label}`.padEnd(opt.width, ' ');
          return (
            <Box key={opt.label} marginRight={1}>
              <Text
                backgroundColor={active ? theme.accent : undefined}
                color={active ? theme.bg : color}
                bold={active}
              >
                {label}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function ChoiceBar({ request, selected }: { request: ChoiceRequest; selected: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={2} paddingY={0}>
      <Text color={theme.accent} bold>{request.question}</Text>
      <Box flexDirection="column">
        {request.options.map((opt, i) => {
          const active = i === selected;
          return (
            <Box key={opt.id}>
              <Text color={active ? theme.accent : theme.inkSoft} bold={active}>
                {active ? '▶ ' : '  '}{opt.title}
              </Text>
              {opt.summary ? <Text color={theme.muted}> — {opt.summary}</Text> : null}
            </Box>
          );
        })}
      </Box>
      <Text color={theme.muted}>↑↓ navigate · ⏎ confirm · esc cancel</Text>
    </Box>
  );
}

export interface InputAreaProps {
  files: FileEntry[];
  helpOpen: boolean;
  pending: PendingState;
  choiceRequest?: ChoiceRequest | null;
  hasMessages: boolean;
  mode: Mode;
  verbose: boolean;
  hasEdits: boolean;
  onSubmit: (text: string) => void;
  onPermAllow: () => void;
  onPermAlwaysAllow: () => void;
  onPermDeny: (note: string) => void;
  onApplyFix: () => void;
  onChoicePick: (optionId: string) => void;
  onChoiceCancel: () => void;
  dispatch: Dispatch;
  cmdCtx: CommandContext;
}

export const InputArea = React.memo(function InputArea({
  files, helpOpen, pending, choiceRequest, hasMessages, mode, verbose, hasEdits,
  onSubmit, onPermAllow, onPermAlwaysAllow, onPermDeny, onApplyFix,
  onChoicePick, onChoiceCancel,
  dispatch, cmdCtx,
}: InputAreaProps) {
  const { exit } = useApp();
  const [inputValue, setInputValue] = useState('');
  const [sel, setSel] = useState(0);
  const [permSel, setPermSel] = useState(0); // 0=allow once  1=always  2=deny
  const [choiceSel, setChoiceSel] = useState(0);
  const [histIdx, setHistIdx] = useState(-1);
  const [savedDraft, setSavedDraft] = useState('');
  const [stash, setStash] = useState('');
  const [history] = useState<string[]>(() => loadHistory().map(h => h.text));
  const prevPermPendingRef = useRef(false);
  const prevChoicePendingRef = useRef(false);
  useEffect(() => {
    const isPermNow = pending === 'permission';
    if (!prevPermPendingRef.current && isPermNow) setPermSel(0);
    prevPermPendingRef.current = isPermNow;
    const isChoiceNow = pending === 'choice';
    if (!prevChoicePendingRef.current && isChoiceNow) setChoiceSel(0);
    prevChoicePendingRef.current = isChoiceNow;
  }, [pending]);
  const promptHistoryRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  const inputRef = useRef('');

  const setInput = useCallback((v: string) => {
    inputRef.current = v;
    setInputValue(v);
  }, []);

  // Derive overlay from ref for zero-lag overlay detection
  const liveInput = inputValue; // use state for memoization stability
  const atToken = useMemo(() => {
    const m = liveInput.match(/(?:^|\s)@([^\s]*)$/);
    return m ? (m[1] ?? '') : null;
  }, [liveInput]);
  const overlay: Overlay = liveInput.startsWith('/') ? 'cmd' : atToken !== null ? 'file' : 'none';

  const cmdItems = useMemo<CmdMatch[]>(
    () => (overlay === 'cmd' ? filterCommands(liveInput) : []),
    [overlay, liveInput],
  );
  const fileItems = useMemo<FileMatch[]>(
    () => (overlay === 'file' ? filterFiles(files, atToken ?? '') : []),
    [overlay, atToken, files],
  );

  const itemCount = overlay === 'cmd' ? cmdItems.length : overlay === 'file' ? fileItems.length : 0;
  const clampedSel = itemCount ? Math.min(sel, itemCount - 1) : 0;

  const completeCommand = useCallback(() => {
    const c = cmdItems[clampedSel]?.cmd;
    if (c) setInput('/' + c.name + ' ');
  }, [cmdItems, clampedSel, setInput]);

  const completeFile = useCallback(() => {
    const f = fileItems[clampedSel]?.file;
    if (!f) return;
    const next = inputRef.current.replace(/(?:^|\s)@[^\s]*$/, (m) =>
      (m.startsWith(' ') ? ' ' : '') + '@' + f.name + ' ');
    setInput(next);
  }, [fileItems, clampedSel, setInput]);

  const stepHistory = useCallback((dir: -1 | 1): boolean => {
    if (!history.length) return false;
    setHistIdx(prev => {
      if (prev === -1) {
        if (dir === 1) return -1;
        setSavedDraft(inputRef.current);
        const next = history.length - 1;
        setInput(history[next]!);
        return next;
      }
      const next = prev + dir;
      if (next < 0) { setInput(history[0]!); return 0; }
      if (next >= history.length) { setInput(savedDraft); return -1; }
      setInput(history[next]!);
      return next;
    });
    return true;
  }, [history, savedDraft, setInput]);

  const handleChange = useCallback((v: string) => {
    if (v === '?' && inputRef.current === '') { dispatch({ type: 'help.toggle' }); return; }
    inputRef.current = v;
    setInputValue(v);
    setSel(0);
    setHistIdx(-1);
  }, [dispatch]);

  // Stable submit handler — deps are only the props/callbacks passed in
  const handleEnter = useCallback((text: string) => {
    if (helpOpen) return;
    if (!text.trim() && pending === 'permission') {
      if (permSel === 1) { onPermAlwaysAllow(); }
      else if (permSel === 2) { onPermDeny('Permission denied.'); }
      else { onPermAllow(); }
      return;
    }
    if (!text.trim() && pending === 'choice' && choiceRequest) {
      const opt = choiceRequest.options[choiceSel];
      if (opt) onChoicePick(opt.id);
      return;
    }
    if (!text.trim() && pending === 'error') { onApplyFix(); return; }

    if (overlay === 'cmd') {
      const c = cmdItems[clampedSel]?.cmd;
      const resolved = c ? '/' + c.name + ' ' + text.replace(/^\/\S*\s*/, '') : text;
      setInput('');
      onSubmit(resolved);
      return;
    }
    if (overlay === 'file') { completeFile(); return; }

    const trimmed = text.trim();
    if (!trimmed) return;

    promptHistoryRef.current.push(trimmed);
    historyIdxRef.current = -1;
    setHistIdx(-1);
    setSavedDraft('');
    setInput('');

    appendHistory(trimmed);
    onSubmit(trimmed);
  }, [helpOpen, pending, permSel, choiceSel, choiceRequest, overlay, cmdItems, clampedSel, onPermAllow, onPermAlwaysAllow, onPermDeny, onApplyFix, onChoicePick, completeFile, setInput, onSubmit]);

  useInput((input, key) => {
    if (helpOpen) {
      if (key.escape || key.return) dispatch({ type: 'help.toggle' });
      return;
    }

    if (key.ctrl && input === 'd') { exit(); return; }

    if (key.ctrl && input === 'r') {
      dispatch({ type: 'verbose.toggle' });
      dispatch({ type: 'toast.show', text: verbose ? 'Verbose off' : 'Verbose on', tone: 'info', ttlMs: 2000 });
      return;
    }

    if (key.ctrl && input === 'u') {
      setStash(inputRef.current);
      setInput('');
      return;
    }

    if (key.meta && input === 's') {
      if (stash) {
        const prev = inputRef.current;
        setInput(stash);
        setStash(prev);
      } else if (inputRef.current) {
        setStash(inputRef.current);
        setInput('');
      }
      return;
    }

    if (input === 'u' && !inputRef.current && overlay === 'none' && hasEdits) {
      dispatch({ type: 'edit.undo' });
      return;
    }

    if (key.ctrl && input === 'p') {
      const hist = promptHistoryRef.current;
      if (!hist.length) return;
      const idx = Math.min(historyIdxRef.current + 1, hist.length - 1);
      historyIdxRef.current = idx;
      setInput(hist[idx]!);
      return;
    }
    if (key.ctrl && input === 'n') {
      const idx = Math.max(historyIdxRef.current - 1, -1);
      historyIdxRef.current = idx;
      setInput(idx >= 0 ? promptHistoryRef.current[idx]! : '');
      return;
    }

    if (pending === 'permission' && !inputRef.current) {
      if (key.leftArrow)  { setPermSel(s => (s - 1 + PERM_OPTIONS.length) % PERM_OPTIONS.length); return; }
      if (key.rightArrow) { setPermSel(s => (s + 1) % PERM_OPTIONS.length); return; }
    }

    if (pending === 'choice' && !inputRef.current && choiceRequest) {
      const count = choiceRequest.options.length;
      if (key.upArrow)   { setChoiceSel(s => (s - 1 + count) % count); return; }
      if (key.downArrow) { setChoiceSel(s => (s + 1) % count); return; }
    }

    if (key.escape) {
      if (pending === 'choice') { onChoiceCancel(); return; }
      if (pending) { onPermDeny(pending === 'permission' ? 'Permission denied.' : 'Left as-is.'); return; }
      if (inputRef.current.length) { setInput(''); return; }
      exit();
      return;
    }

    if (overlay !== 'none' && itemCount) {
      if (key.downArrow) { setSel(s => (s + 1) % itemCount); return; }
      if (key.upArrow)   { setSel(s => (s - 1 + itemCount) % itemCount); return; }
    }
    if (overlay === 'none' && !pending) {
      if (key.upArrow)   { stepHistory(-1); return; }
      if (key.downArrow) { stepHistory(1); return; }
    }
    if (key.tab) {
      if (overlay === 'cmd' && cmdItems.length) { completeCommand(); return; }
      if (overlay === 'file' && fileItems.length) { completeFile(); return; }
      const MODES = ['agent', 'chat', 'orchestrate'] as const;
      const next = MODES[(MODES.indexOf(mode as typeof MODES[number]) + 1) % MODES.length] ?? 'agent';
      dispatch({ type: 'mode.change', mode: next });
      // Mirror the Shift+Tab (edit-mode) toast so a silent mode switch is
      // always acknowledged — the user can see which of agent/chat/orchestrate
      // they landed on without hunting for it in the title/status bar.
      dispatch({ type: 'toast.show', text: `Mode: ${next}`, tone: 'info', ttlMs: 2000 });
      return;
    }
  });

  const placeholder =
    pending === 'permission' ? 'choose a permission action below…'
    : pending === 'choice'   ? '↑↓ to select, ⏎ to confirm…'
    : pending === 'error'    ? 'redirect, or ⏎ to accept the fix'
    : overlay === 'cmd'      ? 'filter commands…'
    : overlay === 'file'     ? 'filter files…'
    : mode === 'orchestrate' ? 'describe task for W0–W4 + W3.5 pipeline…'
    : liveInput === '' && !hasMessages ? 'how can I help?'
    : 'ask, steer, /cmd, @file…  (? for help)';

  return (
    <>
      {helpOpen ? <HelpOverlay /> : null}
      {!helpOpen && overlay === 'cmd' ? <CommandPalette items={cmdItems} selected={clampedSel} /> : null}
      {!helpOpen && overlay === 'file' ? <FilePicker items={fileItems} selected={clampedSel} /> : null}
      {!helpOpen && pending === 'permission' && !inputValue ? <PermissionChoiceBar selected={permSel} /> : null}
      {!helpOpen && pending === 'choice' && choiceRequest && !inputValue ? <ChoiceBar request={choiceRequest} selected={choiceSel} /> : null}
      <Prompt
        value={inputValue}
        onChange={handleChange}
        onSubmit={handleEnter}
        placeholder={placeholder}
        focus={!helpOpen}
      />
    </>
  );
});
