import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { SubagentState, SubagentStatus } from '../types.js';

const MAX_VISIBLE = 4;

const STATUS_GLYPH: Record<SubagentStatus, { symbol: string; color: string }> = {
  running: { symbol: '▶', color: theme.accent },
  done:    { symbol: '✓', color: theme.plus },
  error:   { symbol: '✗', color: theme.danger },
  blocked: { symbol: '!', color: theme.warn },
};

function formatCost(cost: number, currency: 'CNY' | 'Credits'): string {
  if (cost <= 0) return '';
  const symbol = currency === 'Credits' ? 'C' : '¥';
  const digits = currency === 'Credits' ? 1 : 4;
  return `${symbol}${cost.toFixed(digits)}`;
}

function formatTokens(tokens: number): string {
  if (tokens <= 0) return '';
  if (tokens < 1000) return `${tokens} tok`;
  return `${(tokens / 1000).toFixed(1)}k tok`;
}

function describeAction(s: SubagentState): string {
  if (!s.lastTool) return 'preparing…';
  const args = s.lastToolArgs ? ` ${s.lastToolArgs}` : '';
  return `${s.lastTool}${args}`;
}

/**
 * Compact one-line brief per active sub-agent. Lives below the PipelinePanel
 * so the user can watch which task is doing what without scrolling the chat
 * stream. Tool calls and per-task token/cost totals only show up here; the
 * main chat is reserved for the agent's own messages + task-done summaries.
 */
export const SubagentBrief = React.memo(function SubagentBrief({
  subagents,
}: { subagents: SubagentState[] }) {
  if (!subagents.length) return null;

  // Show running ones first (more interesting), then most-recently-updated.
  const ordered = [...subagents].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return b.updatedAt - a.updatedAt;
  });
  const visible = ordered.slice(0, MAX_VISIBLE);
  const hidden = ordered.length - visible.length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.muted} bold>SUBAGENTS</Text>
      {visible.map((s) => {
        const glyph = STATUS_GLYPH[s.status];
        const stepLabel = s.maxSteps > 0 ? `step ${s.step}/${s.maxSteps}` : `step ${s.step}`;
        return (
          <Box key={s.taskId}>
            <Text color={glyph.color}>{glyph.symbol} </Text>
            <Text color={theme.ink} bold>{s.taskId}</Text>
            <Text color={theme.muted}> {s.personaId}</Text>
            <Text color={theme.muted}> · </Text>
            <Text color={theme.inkSoft}>{stepLabel}</Text>
            <Text color={theme.muted}> · </Text>
            <Text color={s.status === 'running' ? theme.accent : theme.inkSoft}>
              {describeAction(s)}
            </Text>
            {formatTokens(s.tokens) && (
              <>
                <Text color={theme.muted}> · </Text>
                <Text color={theme.muted}>{formatTokens(s.tokens)}</Text>
              </>
            )}
            {formatCost(s.cost, s.currency) && (
              <>
                <Text color={theme.muted}> </Text>
                <Text color={theme.plus}>{formatCost(s.cost, s.currency)}</Text>
              </>
            )}
          </Box>
        );
      })}
      {hidden > 0 && (
        <Text color={theme.muted}>  …{hidden} more</Text>
      )}
    </Box>
  );
});
