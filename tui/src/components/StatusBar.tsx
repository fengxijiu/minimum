import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { TokenMeter } from './atoms.js';
import type { SessionState } from '../types.js';

const PILL: Record<SessionState, { label: string; color: string }> = {
  agent:  { label: 'agent',  color: theme.accent },
  mimo:   { label: 'mimo',   color: theme.accent },
  paused: { label: 'paused', color: theme.warn },
  error:  { label: 'error',  color: theme.danger },
};

function Key({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text color={theme.ink}>{k}</Text>
      <Text color={theme.muted}> {label}  </Text>
    </Text>
  );
}

export function StatusBar({ state, ctxUsed, ctxMax, hint }: {
  state: SessionState;
  ctxUsed: number;
  ctxMax: number;
  hint?: string;
}) {
  const pill = PILL[state];
  // Keys shift with state, mirroring the design's per-state status bar.
  const keys =
    state === 'paused' ? [['⏎', 'allow'], ['n', 'deny']]
    : state === 'error' ? [['⏎', 'fix'], ['u', 'undo'], ['l', 'log']]
    : [['tab', 'mode'], ['esc', 'quit'], ['/', 'cmd'], ['@', 'file']];

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text backgroundColor={pill.color} color={theme.bg} bold>
          {' '}{pill.label}{' '}
        </Text>
        <Text color={theme.muted}>  mimo  </Text>
        <TokenMeter used={ctxUsed} max={ctxMax} />
        <Text color={theme.muted}>  ·  </Text>
        {keys.map(([k, l]) => <Key key={k} k={k!} label={l!} />)}
      </Box>
      <Text color={theme.muted}>{hint ?? ''}</Text>
    </Box>
  );
}
