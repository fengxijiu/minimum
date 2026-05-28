#!/usr/bin/env node
import React from 'react';
import { render, Box, Text } from 'ink';
import { App } from './app.js';
import { createEngineRunner } from './engine.js';

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
  const { waitUntilExit } = render(<App runner={runner} cwd={cwd} />);
  await waitUntilExit();
} catch (err: any) {
  render(
    <Box flexDirection="column" padding={1}>
      <Text color="red" bold>Failed to start Minimum</Text>
      <Text color="white">{err.message}</Text>
    </Box>
  );
}

cleanup();
