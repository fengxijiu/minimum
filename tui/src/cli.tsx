#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './app.js';
import { createEngineRunner } from './engine.js';

// ── Alternate screen ──────────────────────────────────────────────────
// Enter before Ink starts rendering so the live region fills a clean canvas.
process.stdout.write('\x1b[?1049h');

let _altRestored = false;
const restoreAlt = () => {
  if (_altRestored) return;
  _altRestored = true;
  process.stdout.write('\x1b[?1049l');
};
process.on('exit', restoreAlt);
process.on('SIGINT', () => { restoreAlt(); process.exit(0); });
process.on('SIGTERM', () => { restoreAlt(); process.exit(0); });

const { runner, pipelineRunner, info } = await createEngineRunner(process.cwd());
const { waitUntilExit } = render(<App runner={runner} pipelineRunner={pipelineRunner} engineInfo={info} />);
await waitUntilExit();
restoreAlt();
