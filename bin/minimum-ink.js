#!/usr/bin/env node

/**
 * Minimum — main entry point.
 * Delegates to the Ink TUI package (tui/dist/cli.js) which owns its own
 * node_modules and renders the full 3-panel interface.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const dir = dirname(fileURLToPath(import.meta.url));
const tuiEntry = resolve(dir, '..', 'tui', 'dist', 'cli.js');

const child = spawn(process.execPath, [tuiEntry], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
