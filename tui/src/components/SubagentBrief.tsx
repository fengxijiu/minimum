import React from 'react';
import { Box, Text, useStdout } from 'ink';
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

/** Clip a string to `max` columns, marking the cut with an ellipsis. */
function truncate(s: string, max: number): string {
  if (max <= 1) return s.length ? '…' : '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function stepLabelOf(s: SubagentState): string {
  return s.maxSteps > 0 ? `step ${s.step}/${s.maxSteps}` : `step ${s.step}`;
}

/**
 * Compact one-line brief per active sub-agent. Lives below the PipelinePanel
 * so the user can watch which task is doing what without scrolling the chat
 * stream. Tool calls and per-task token/cost totals only show up here; the
 * main chat is reserved for the agent's own messages + task-done summaries.
 *
 * Rows are sorted by taskId and laid out in fixed-width columns so the
 * taskId / persona / step fields line up into clean vertical rails; the action
 * column (often a long tool arg like a regex) is clipped to the terminal width
 * so a single noisy call can't blow out the panel.
 */
export const SubagentBrief = React.memo(function SubagentBrief({
  subagents,
}: { subagents: SubagentState[] }) {
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;

  if (!subagents.length) return null;

  // Running first (most interesting), then stable by taskId so rows don't
  // jump around as updatedAt churns.
  const ordered = [...subagents].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return a.taskId.localeCompare(b.taskId, undefined, { numeric: true });
  });
  const visible = ordered.slice(0, MAX_VISIBLE);
  const hidden = ordered.length - visible.length;

  const runningCount = subagents.filter(s => s.status === 'running').length;
  const doneCount = subagents.filter(s => s.status === 'done').length;
  const summary = [
    doneCount > 0 ? `${doneCount} done` : '',
    runningCount > 0 ? `${runningCount} running` : '',
  ].filter(Boolean).join(' · ');

  // Column widths from the visible rows so fields align into vertical rails.
  const taskW = Math.max(5, ...visible.map(s => s.taskId.length));
  const personaW = Math.max(...visible.map(s => s.personaId.length));
  const stepW = Math.max(...visible.map(s => stepLabelOf(s).length));

  // Remaining columns for the action, after border(2) + paddingX(2) + glyph(2)
  // + the three padded fields and their single-space gutters.
  const prefixW = 2 + taskW + 1 + personaW + 1 + stepW + 1;
  const actionW = Math.max(8, termWidth - 4 - prefixW);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.line} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.muted} bold>SUBAGENTS</Text>
        {summary ? <Text color={theme.muted}>{summary}</Text> : null}
      </Box>
      {visible.map((s) => {
        const g = STATUS_GLYPH[s.status];
        const tokens = formatTokens(s.tokens);
        const cost = formatCost(s.cost, s.currency);
        // Reserve room for the token/cost tail so it never gets pushed off-screen.
        const tail = (tokens ? tokens.length + 3 : 0) + (cost ? cost.length + 1 : 0);
        const action = truncate(describeAction(s), Math.max(8, actionW - tail));
        return (
          <Box key={s.taskId} flexDirection="row">
            <Box width={2}><Text color={g.color}>{g.symbol}</Text></Box>
            <Text color={theme.ink} bold>{s.taskId.padEnd(taskW)}</Text>
            <Text color={theme.muted}> {s.personaId.padEnd(personaW)}</Text>
            <Text color={theme.inkSoft}> {stepLabelOf(s).padEnd(stepW)}</Text>
            <Text color={s.status === 'running' ? theme.accent : theme.inkSoft}> {action}</Text>
            {tokens && <Text color={theme.muted}> · {tokens}</Text>}
            {cost && <Text color={theme.plus}> {cost}</Text>}
          </Box>
        );
      })}
      {hidden > 0 && <Text color={theme.muted}>  …{hidden} more</Text>}
    </Box>
  );
});
