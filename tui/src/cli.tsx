#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { createEngineRunner } from './engine.js';
import { flushTuiSessionSync, loadLatestTuiSession } from './session.js';

// ── Inline (non-fullscreen) rendering ────────────────────────────────
// Claude Code style: no alternate screen and no mouse capture, so the
// terminal's own scrollback owns the conversation history. Completed
// messages are printed once (via <Static>) and scroll away naturally;
// only the live turn + input box are repainted in place at the bottom.

// ── Buffered + diffed synchronized output ────────────────────────────
// A single Ink render fires several stdout writes — log.clear(), the
// <Static> chunk, the dynamic frame, plus cli-cursor hide/show. Writing
// each one immediately (and wrapping each in its own synchronized-update
// pair) tears one logical frame across several terminal repaints.
//
// Instead we BUFFER every write that lands in the same tick and emit them
// as ONE frame wrapped in a single BSU/ESU (DEC mode 2026) pair, so the
// terminal swaps the whole frame in atomically — no partial-repaint
// flicker. We also DIFF against the last emitted frame and drop it when
// nothing changed, avoiding redundant repaints. Terminals that don't
// support mode 2026 ignore the sequences and still get correct output.
const _origWrite = process.stdout.write.bind(process.stdout);

let pending: string[] = [];          // writes accumulated during this tick
let scheduled = false;               // is a flush queued?
let lastFrame: string | null = null; // last frame actually emitted (diff guard)

const emit = (frame: string): void => {
  if (frame === '') return;          // diff: nothing buffered
  if (frame === lastFrame) return;   // diff: identical to last frame → skip
  lastFrame = frame;
  // One synchronized-update pair around the entire batched frame.
  _origWrite('\x1b[?2026h' + frame + '\x1b[?2026l');
};

const flush = (): void => {
  scheduled = false;
  if (pending.length === 0) return;
  const frame = pending.join('');
  pending = [];
  emit(frame);
};

(process.stdout as any).write = (chunk: any, enc?: any, cb?: any): boolean => {
  const text = typeof chunk === 'string'
    ? chunk
    : Buffer.from(chunk).toString(typeof enc === 'string' ? (enc as BufferEncoding) : 'utf8');
  pending.push(text);
  if (!scheduled) {
    scheduled = true;
    setImmediate(flush);
  }
  // Honour the write callback contract (chunk[, encoding][, callback]).
  const done = typeof enc === 'function' ? enc : cb;
  if (typeof done === 'function') done();
  return true;
};

// Flush any buffered frame synchronously on exit so the final paint —
// including cli-cursor's "show cursor" sequence — is never dropped.
const flushSync = (): void => { if (pending.length) flush(); };
process.on('exit', flushSync);

const args = new Set(process.argv.slice(2));
const shouldResume = args.has('--resume');
const { runner, pipelineRunner, info, sessionFlusher, choiceGate } = await createEngineRunner(process.cwd());
const initialSession = shouldResume ? await loadLatestTuiSession() : null;

// SIGINT: flush buffered terminal frame + persist session before exit.
process.on('SIGINT', () => {
  flushSync();
  sessionFlusher?.flushSync();
  // P1: 同步冲刷 TUI session，防止异步保存被 SIGINT 中断
  flushTuiSessionSync();
  process.exit(0);
});

// exitOnCtrlC: false — Ctrl+C is repurposed as "stop current task" (press twice).
// Without this, Ink's default handler would kill the process on the first press.
const { waitUntilExit } = render(
  <App runner={runner} pipelineRunner={pipelineRunner} engineInfo={info} choiceGate={choiceGate} initialSession={initialSession} />,
  { exitOnCtrlC: false },
);
await waitUntilExit();
flushSync();
sessionFlusher?.flushSync();
// P1: 同步冲刷 TUI session，确保正常退出时 session 不丢失
flushTuiSessionSync();
