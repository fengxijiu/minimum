import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { TokenMeter } from './atoms.js';
import type { ApprovalMode, EditMode, SessionState, UsageInfo } from '../types.js';

const PILL: Record<SessionState, { label: string; color: string }> = {
  agent:       { label: 'agent',       color: theme.accent },
  mimo:        { label: 'mimo',        color: theme.accent },
  orchestrate: { label: 'orchestrate', color: theme.accent2 },
  paused:      { label: 'paused',      color: theme.warn },
  error:       { label: 'error',       color: theme.danger },
};

const MODE_BADGE: Record<ApprovalMode, { label: string; color: string }> = {
  'read-only': { label: 'read-only', color: theme.warn },
  'auto-edit': { label: 'auto-edit', color: theme.accent },
  'full-auto': { label: 'full-auto', color: '#4dff91' },
};

const EDIT_BADGE: Record<EditMode, { label: string; color: string }> = {
  review: { label: 'review', color: theme.warn },
  auto:   { label: 'auto',   color: theme.accent },
  yolo:   { label: 'yolo',   color: theme.danger },
};

function Key({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text color={theme.ink}>{k}</Text>
      <Text color={theme.muted}> {label}  </Text>
    </Text>
  );
}

export const StatusBar = React.memo(function StatusBar({ state, approvalMode, editMode, ctxUsed, ctxMax, hint, usage, mcpLoading }: {
  state: SessionState;
  approvalMode?: ApprovalMode;
  editMode?: EditMode;
  ctxUsed: number;
  ctxMax: number;
  hint?: string;
  usage?: UsageInfo;
  mcpLoading?: { ready: number; total: number } | null;
}) {
  const pill = PILL[state];
  const badge = approvalMode ? MODE_BADGE[approvalMode] : null;
  const editBadge = editMode ? EDIT_BADGE[editMode] : null;

  // Keys shift with state, mirroring the design's per-state status bar.
  const keys =
    state === 'paused' ? [['⏎', 'allow'], ['n', 'deny']]
    : state === 'error' ? [['⏎', 'fix'], ['u', 'undo'], ['l', 'log']]
    : [['tab', 'mode'], ['S+Tab', 'edit'], ['esc', 'quit'], ['/', 'cmd']];

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
        {editBadge && (
          <>
            <Text color={theme.muted}> </Text>
            <Text color={editBadge.color}>({editBadge.label})</Text>
          </>
        )}
        {mcpLoading && (
          <>
            <Text color={theme.muted}> </Text>
            <Text color={theme.accent}>mcp {mcpLoading.ready}/{mcpLoading.total}</Text>
          </>
        )}
        <Text color={theme.muted}>  mimo  </Text>
        <TokenMeter used={ctxUsed} max={ctxMax} />
        {usage && usage.lastTurnCost > 0 && (
          <>
            <Text color={theme.muted}>  ·  </Text>
            <Text color={theme.plus}>${usage.lastTurnCost.toFixed(4)}</Text>
            <Text color={theme.muted}>  Σ${usage.sessionCost.toFixed(2)}</Text>
          </>
        )}
        <Text color={theme.muted}>  ·  </Text>
        {keys.map(([k, l]) => <Key key={k} k={k!} label={l!} />)}
      </Box>
      <Text color={theme.muted}>{hint ?? ''}</Text>
    </Box>
  );
});
