import React, { useState, useCallback, useRef, useMemo } from 'react';
import { useInput, useApp } from 'ink';
import { CommandPalette } from './CommandPalette.js';
import { FilePicker } from './FilePicker.js';
import { HelpOverlay } from './HelpOverlay.js';
import { Prompt } from './Prompt.js';
import { filterCommands, type CommandContext } from '../commands.js';
import { loadHistory, appendHistory } from '../inputHistory.js';
import type { FileEntry, PendingState, Mode, EditMode } from '../types.js';
import type { Dispatch } from '../state/store.js';

type Overlay = 'none' | 'cmd' | 'file';

export interface InputAreaProps {
  files: FileEntry[];
  helpOpen: boolean;
  pending: PendingState;
  hasMessages: boolean;
  mode: Mode;
  editMode: EditMode;
  verbose: boolean;
  hasEdits: boolean;
  onSubmit: (text: string) => void;
  onPermAllow: () => void;
  onPermDeny: (note: string) => void;
  onApplyFix: () => void;
  dispatch: Dispatch;
  cmdCtx: CommandContext;
}

export const InputArea = React.memo(function InputArea({
  files, helpOpen, pending, hasMessages, mode, editMode, verbose, hasEdits,
  onSubmit, onPermAllow, onPermDeny, onApplyFix, dispatch, cmdCtx,
}: InputAreaProps) {
  const { exit } = useApp();
  const [inputValue, setInputValue] = useState('');
  const [sel, setSel] = useState(0);
  const [histIdx, setHistIdx] = useState(-1);
  const [savedDraft, setSavedDraft] = useState('');
  const [stash, setStash] = useState('');
  const [history] = useState<string[]>(() => loadHistory().map(h => h.text));
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

  const cmdItems = useMemo(
    () => (overlay === 'cmd' ? filterCommands(liveInput) : []),
    [overlay, liveInput],
  );
  const fileItems = useMemo<FileEntry[]>(() => {
    if (overlay !== 'file') return [];
    const q = (atToken ?? '').toLowerCase();
    return files.filter(f => f.name.toLowerCase().includes(q));
  }, [overlay, atToken, files]);

  const itemCount = overlay === 'cmd' ? cmdItems.length : overlay === 'file' ? fileItems.length : 0;
  const clampedSel = itemCount ? Math.min(sel, itemCount - 1) : 0;

  const completeCommand = useCallback(() => {
    const c = cmdItems[clampedSel];
    if (c) setInput('/' + c.name + ' ');
  }, [cmdItems, clampedSel, setInput]);

  const completeFile = useCallback(() => {
    const f = fileItems[clampedSel];
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
    if (!text.trim() && pending === 'permission') { onPermAllow(); return; }
    if (!text.trim() && pending === 'error') { onApplyFix(); return; }

    if (overlay === 'cmd') {
      const c = cmdItems[clampedSel];
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
  }, [helpOpen, pending, overlay, cmdItems, clampedSel, onPermAllow, onApplyFix, completeFile, setInput, onSubmit]);

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

    if (key.shift && key.tab) {
      const modes = ['review', 'auto', 'yolo'] as const;
      const next = modes[(modes.indexOf(editMode) + 1) % modes.length]!;
      dispatch({ type: 'edit.mode.change', mode: next });
      dispatch({ type: 'toast.show', text: `Edit mode: ${next}`, tone: 'info', ttlMs: 2000 });
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

    if (key.escape) {
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
      dispatch({ type: 'mode.change', mode: mode === 'agent' ? 'chat' : 'agent' });
      return;
    }
  });

  const placeholder =
    pending === 'permission' ? 'agent paused — ⏎ to allow, or type to redirect'
    : pending === 'error'    ? 'redirect, or ⏎ to accept the fix'
    : overlay === 'cmd'      ? 'filter commands…'
    : overlay === 'file'     ? 'filter files…'
    : liveInput === '' && !hasMessages ? 'how can I help?'
    : 'ask, steer, /cmd, @file…  (? for help)';

  return (
    <>
      {helpOpen ? <HelpOverlay /> : null}
      {!helpOpen && overlay === 'cmd' ? <CommandPalette items={cmdItems} selected={clampedSel} /> : null}
      {!helpOpen && overlay === 'file' ? <FilePicker items={fileItems} selected={clampedSel} /> : null}
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
