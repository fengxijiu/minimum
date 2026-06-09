import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { CommandPalette } from './CommandPalette.js';
import { FilePicker } from './FilePicker.js';
import { HelpOverlay } from './HelpOverlay.js';
import { Prompt } from './Prompt.js';
import { filterCommands, filterFiles, type CommandContext, type CmdMatch, type FileMatch } from '../commands.js';
import { loadHistory, appendHistory } from '../inputHistory.js';
import type { ApprovalMode, FileEntry, PendingState, Mode, ChoiceRequest } from '../types.js';
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

function truncateStr(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// Question and context are committed to static scrollback before this bar is shown,
// so they never participate in Ink's live-region redraws. The bar only contains the
// fixed-height option list, preventing flicker and vertical jumping on long text.
function ChoiceBar({ request, selected }: { request: ChoiceRequest; selected: number }) {
  const termCols = process.stdout.columns ?? 80;
  // Leave room for border (2) + paddingX (2 each side = 4) + cursor prefix (2).
  const titleMax = Math.max(20, termCols - 12);
  const summaryMax = Math.max(10, Math.floor(termCols / 3));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={2} paddingY={0}>
      <Text color={theme.accent} bold>{truncateStr(request.question, titleMax)}</Text>
      <Text color={theme.muted}>Review the summary above, then choose an action.</Text>
      <Box flexDirection="column">
        {request.options.map((opt, i) => {
          const active = i === selected;
          const title = truncateStr(opt.title, titleMax);
          const summary = opt.summary ? truncateStr(opt.summary, summaryMax) : undefined;
          return (
            <Box key={opt.id}>
              <Text color={active ? theme.accent : theme.inkSoft} bold={active}>
                {active ? '▶ ' : '  '}{title}
              </Text>
              {summary ? <Text color={theme.muted}> — {summary}</Text> : null}
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
  /** Whether an LLM turn is currently in flight. Ctrl+C ×2 only cancels if true. */
  turnInProgress: boolean;
  onSubmit: (text: string) => void;
  onPermAllow: () => void;
  onPermAlwaysAllow: () => void;
  onPermDeny: (note: string) => void;
  onApplyFix: () => void;
  onChoicePick: (optionId: string) => void;
  onChoiceCancel: () => void;
  /** Abort the current turn — invoked by the second Ctrl+C within DOUBLE_CTRLC_MS. */
  onCancelTurn: () => void;
  /** Current permission mode; used only for the Shift+Tab toast / next-mode lookup. */
  approvalMode?: ApprovalMode;
  /** Shift+Tab — advance to the next entry in the read-only → auto-edit → full-auto cycle. */
  onCycleApprovalMode: () => void;
  dispatch: Dispatch;
  cmdCtx: CommandContext;
}

/** Window (ms) within which a second Ctrl+C is treated as a confirmation. */
const DOUBLE_CTRLC_MS = 2000;

export const InputArea = React.memo(function InputArea({
  files, helpOpen, pending, choiceRequest, hasMessages, mode, verbose, hasEdits,
  turnInProgress,
  onSubmit, onPermAllow, onPermAlwaysAllow, onPermDeny, onApplyFix,
  onChoicePick, onChoiceCancel, onCancelTurn,
  onCycleApprovalMode,
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
  const choiceDraftRef = useRef<string | null>(null);
  const promptHistoryRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1);
  const inputRef = useRef('');
  const setInput = useCallback((v: string) => {
    inputRef.current = v;
    setInputValue(v);
  }, []);
  useEffect(() => {
    const isPermNow = pending === 'permission';
    if (!prevPermPendingRef.current && isPermNow) setPermSel(0);
    prevPermPendingRef.current = isPermNow;
    const isChoiceNow = pending === 'choice';
    if (!prevChoicePendingRef.current && isChoiceNow) {
      setChoiceSel(0);
      // CHANGED: choice gate must preempt any draft so the confirmation UI is visible.
      if (inputRef.current) {
        choiceDraftRef.current = inputRef.current;
        setInput('');
      } else {
        choiceDraftRef.current = null;
      }
    }
    // CHANGED: restore the pre-choice draft after the gate resolves if the user
    // has not already typed a new input.
    if (prevChoicePendingRef.current && !isChoiceNow && choiceDraftRef.current !== null && !inputRef.current) {
      setInput(choiceDraftRef.current);
      choiceDraftRef.current = null;
    }
    prevChoicePendingRef.current = isChoiceNow;
  }, [pending, setInput]);
  // Timestamp of the last Ctrl+C press; a second press within DOUBLE_CTRLC_MS
  // is treated as confirmation to abort the in-flight turn. Process exit on
  // Ctrl+C is blocked at the Ink layer (exitOnCtrlC: false in cli.tsx).
  const lastCtrlCRef = useRef(0);

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
    // ── Ctrl+C: blocks process exit; double-press cancels in-flight turn ──
    // First press: warn via toast; second press within DOUBLE_CTRLC_MS:
    //   - if a turn is running → abort it
    //   - otherwise → reset the lastCtrlC clock (no-op exit; user must use
    //     Ctrl+D or /quit to leave)
    if (key.ctrl && input === 'c') {
      const now = Date.now();
      const isSecondPress = now - lastCtrlCRef.current < DOUBLE_CTRLC_MS;
      if (isSecondPress) {
        lastCtrlCRef.current = 0;
        if (turnInProgress) {
          onCancelTurn();
        }
        return;
      }
      lastCtrlCRef.current = now;
      const hint = turnInProgress
        ? 'Press Ctrl+C again to stop the current task'
        : 'Ctrl+C does not exit — use Ctrl+D or /quit';
      dispatch({ type: 'toast.show', text: hint, tone: 'warn', ttlMs: DOUBLE_CTRLC_MS });
      return;
    }

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
      // Shift+Tab cycles permission modes (read-only → auto-edit → full-auto).
      // Checked before completion handlers so it still works while an overlay
      // is open; completions only react to plain Tab.
      if (key.shift) {
        onCycleApprovalMode();
        return;
      }
      if (overlay === 'cmd' && cmdItems.length) { completeCommand(); return; }
      if (overlay === 'file' && fileItems.length) { completeFile(); return; }
      const MODES = ['agent', 'chat', 'orchestrate'] as const;
      const next = MODES[(MODES.indexOf(mode as typeof MODES[number]) + 1) % MODES.length] ?? 'agent';
      dispatch({ type: 'mode.change', mode: next });
      // Toast so a silent mode switch is always acknowledged — user can see
      // which of agent/chat/orchestrate they landed on without hunting the
      // status bar.
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
    : mode === 'orchestrate' ? 'describe a task for the Plan→Build→Finalize pipeline…'
    : liveInput === '' && !hasMessages ? 'how can I help?'
    : 'ask, steer, /cmd, @file…  (? for help)';

  return (
    <>
      {helpOpen ? <HelpOverlay /> : null}
      {!helpOpen && overlay === 'cmd' ? <CommandPalette items={cmdItems} selected={clampedSel} /> : null}
      {!helpOpen && overlay === 'file' ? <FilePicker items={fileItems} selected={clampedSel} /> : null}
      {!helpOpen && pending === 'permission' && !inputValue ? <PermissionChoiceBar selected={permSel} /> : null}
      {!helpOpen && pending === 'choice' && choiceRequest ? <ChoiceBar request={choiceRequest} selected={choiceSel} /> : null}
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
