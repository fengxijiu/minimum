import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { TokenMeter } from './atoms.js';
import type { ApprovalMode, SessionState } from '../types.js';

const PILL: Record<SessionState, { label: string; color: string }> = {
  agent:  { label: 'agent',  color: theme.accent },
  mimo:   { label: 'mimo',   color: theme.accent },
  paused: { label: 'paused', color: theme.warn },
  error:  { label: 'error',  color: theme.danger },
};

const MODE_BADGE: Record<ApprovalMode, { label: string; color: string }> = {
  'read-only': { label: 'read-only', color: theme.warn },
  'auto-edit': { label: 'auto-edit', color: theme.accent },
  'full-auto': { label: 'full-auto', color: '#4dff91' },
};

function Key({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text color={theme.ink}>{k}</Text>
      <Text color={theme.muted}> {label}  </Text>
    </Text>
  );
}

export function StatusBar({ state, approvalMode, ctxUsed, ctxMax, hint }: {
  state: SessionState;
  approvalMode?: ApprovalMode;
  ctxUsed: number;
  ctxMax: number;
  hint?: string;
}) {
  const pill = PILL[state];
  const badge = approvalMode ? MODE_BADGE[approvalMode] : null;

  // Keys shift with state, mirroring the design's per-state status bar.
  const keys =
    state === 'paused' ? [['⏎', 'allow'], ['n', 'deny']]
    : state === 'error' ? [['⏎', 'fix'], ['u', 'undo'], ['l', 'log']]
    : [['tab', 'mode'], ['/approval', 'lock'], ['esc', 'quit'], ['/', 'cmd']];

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text backgroundColor={pill.color} color={theme.bg} bold>
          {' '}{pill.label}{' '}
        </Text>
        {badge && (
          <>
            <Text color={theme.muted}> </Text>
            <Text color={badge.color}>[{badge.label}]</Text>
          </>
        )}
        <Text color={theme.muted}>  mimo  </Text>
        <TokenMeter used={ctxUsed} max={ctxMax} />
        <Text color={theme.muted}>  ·  </Text>
        {keys.map(([k, l]) => <Key key={k} k={k!} label={l!} />)}
      </Box>
      <Text color={theme.muted}>{hint ?? ''}</Text>
    </Box>
  );
}
