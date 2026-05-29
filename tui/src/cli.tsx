#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { createEngineRunner } from './engine.js';

// ── Inline (non-fullscreen) rendering ────────────────────────────────
// Claude Code style: no alternate screen and no mouse capture, so the
// terminal's own scrollback owns the conversation history. Completed
// messages are printed once (via <Static>) and scroll away naturally;
// only the live turn + input box are repainted in place at the bottom.

// ── Synchronized output (DEC mode 2026) ──────────────────────────────
// Wraps each stdout.write in a BSU/ESU pair so the terminal renders frames
// atomically — eliminates partial-repaint flicker on every keypress.
// Terminals that don't support mode 2026 silently ignore the sequences.
const _origWrite = process.stdout.write.bind(process.stdout);
(process.stdout as any).write = (chunk: any, enc?: any, cb?: any): boolean => {
  _origWrite('\x1b[?2026h'); // begin synchronized update
  const r = _origWrite(chunk, enc, cb);
  _origWrite('\x1b[?2026l'); // end synchronized update
  return r;
};

const { runner, pipelineRunner, info } = await createEngineRunner(process.cwd());
const { waitUntilExit } = render(<App runner={runner} pipelineRunner={pipelineRunner} engineInfo={info} />);
await waitUntilExit();
