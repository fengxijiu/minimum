#!/usr/bin/env node

/**
 * Minimum TUI - Ink React TUI
 */

import React from 'react';
import { render, Box, Text } from 'ink';
import { App } from '../tui/dist/app.js';
import { createEngineRunner } from '../tui/dist/engine.js';

const cwd = process.cwd();

// Use alternate screen buffer — each render replaces the entire screen.
process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');

const cleanup = () => {
  process.stdout.write('\x1b[?1049l');
};

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

try {
  const runner = await createEngineRunner(cwd);
  const { waitUntilExit } = render(React.createElement(App, { runner, cwd }));
  await waitUntilExit();
} catch (err) {
  render(
    React.createElement(Box, { flexDirection: 'column', padding: 1 },
      React.createElement(Text, { color: 'red', bold: true }, 'Failed to start Minimum'),
      React.createElement(Text, { color: 'white' }, err.message),
    )
  );
}

cleanup();
