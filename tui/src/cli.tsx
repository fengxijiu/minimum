#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { createEngineRunner } from './engine.js';

// ── Alternate screen + mouse tracking ────────────────────────────────
process.stdout.write('\x1b[?1049h'); // alternate screen
process.stdout.write('\x1b[?1000h'); // mouse button/wheel tracking
process.stdout.write('\x1b[?1006h'); // SGR extended mouse (large coords)

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

let _altRestored = false;
const restoreAlt = () => {
  if (_altRestored) return;
  _altRestored = true;
  process.stdout.write('\x1b[?1006l'); // disable SGR mouse
  process.stdout.write('\x1b[?1000l'); // disable mouse tracking
  process.stdout.write('\x1b[?1049l'); // exit alternate screen
};
process.on('exit', restoreAlt);
process.on('SIGINT', () => { restoreAlt(); process.exit(0); });
process.on('SIGTERM', () => { restoreAlt(); process.exit(0); });

const { runner, pipelineRunner, info } = await createEngineRunner(process.cwd());
const { waitUntilExit } = render(<App runner={runner} pipelineRunner={pipelineRunner} engineInfo={info} />);
await waitUntilExit();
restoreAlt();
