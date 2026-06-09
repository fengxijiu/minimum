import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { TokenMeter } from './atoms.js';
import type { ApprovalMode, SessionState, UsageInfo } from '../types.js';

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
  'aware': { label: 'aware', color: theme.accent2 },
  'full-auto': { label: 'full-auto', color: '#4dff91' },
};

const Key = React.memo(function Key({ k, label }: { k: string; label: string }) {
  return (
    <Text>
      <Text color={theme.ink}>{k}</Text>
      <Text color={theme.muted}> {label}  </Text>
    </Text>
  );
});

export const StatusBar = React.memo(function StatusBar({ state, approvalMode, ctxUsed, ctxMax, hint, usage, mcpLoading, showAwareApproval = true }: {
  state: SessionState;
  approvalMode?: ApprovalMode;
  ctxUsed: number;
  ctxMax: number;
  hint?: string;
  usage?: UsageInfo;
  mcpLoading?: { ready: number; total: number } | null;
  showAwareApproval?: boolean;
}) {
  const pill = PILL[state];
  const badge = approvalMode && (approvalMode !== 'aware' || showAwareApproval)
    ? MODE_BADGE[approvalMode]
    : null;

  // Keys shift with state, mirroring the design's per-state status bar.
  const keys =
    state === 'paused' ? [['⏎', 'allow'], ['n', 'deny']]
    : state === 'error' ? [['⏎', 'fix'], ['u', 'undo'], ['l', 'log']]
    : [['tab', 'mode'], ['S+Tab', 'perm'], ['esc', 'quit'], ['/', 'cmd']];

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text backgroundColor={pill.color} color={theme.bg} bold>
          {' '}{pill.label}{' '}
        </Text>
        {badge && (
          <>
            <Text color={theme.muted}> </Text>
            <Text color={badge.color}>[perm {badge.label}]</Text>
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
        {usage && (usage.lastTurnCost > 0 || usage.sessionCost > 0) && (() => {
          // Credits-mode is Token Plan billing — values are larger and integer-
          // ish, so 1 decimal and "C" prefix; CNY-mode is fractional yuan so
          // 4 decimals for the turn cost and 2 for the running total.
          const isCredits = usage.currency === 'Credits';
          const symbol = isCredits ? 'C' : '¥';
          const turnDigits = isCredits ? 1 : 4;
          const sessionDigits = isCredits ? 1 : 2;
          return (
            <>
              <Text color={theme.muted}>  ·  </Text>
              <Text color={theme.plus}>{symbol}{usage.lastTurnCost.toFixed(turnDigits)}</Text>
              <Text color={theme.muted}>  Σ{symbol}{usage.sessionCost.toFixed(sessionDigits)}</Text>
              {usage.cacheHit > 0 && (
                <Text color={theme.muted}>  cache {Math.round(usage.cacheHit * 100)}%</Text>
              )}
            </>
          );
        })()}
        <Text color={theme.muted}>  ·  </Text>
        {keys.map(([k, l]) => <Key key={k} k={k!} label={l!} />)}
      </Box>
      <Text color={theme.muted}>{hint ?? ''}</Text>
    </Box>
  );
});
