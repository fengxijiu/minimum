import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { PlanStep } from '../types.js';

// Threshold above which we collapse to a single-line compact strip.
const COMPACT_THRESHOLD = 4;

/** Progress bar: === current === remaining === */
function PlanBar({ done, total, now }: { done: number; total: number; now: number }) {
  const width = 16;
  const doneW = Math.round((done / total) * width);
  const nowW  = Math.min(1, Math.max(0, total - done > 0 ? 1 : 0));
  const restW = Math.max(0, width - doneW - nowW);
  return (
    <Text>
      <Text color={theme.plus}>{'═'.repeat(doneW)}</Text>
      {nowW > 0 && <Text color={theme.accent}>⊙</Text>}
      <Text color={theme.line}>{'─'.repeat(restW)}</Text>
    </Text>
  );
}

export const PlanStrip = React.memo(function PlanStrip({ title, steps }: {
  title: string;
  steps: PlanStep[];
}) {
  if (steps.length === 0) return <Box />;

  const done   = steps.filter(s => s.status === 'done').length;
  const nowIdx = steps.findIndex(s => s.status === 'now');
  const nowStep = nowIdx >= 0 ? steps[nowIdx] : null;

  // Compact single-line strip for longer plans — prevents height overflow.
  if (steps.length > COMPACT_THRESHOLD) {
    return (
      <Box paddingX={1}>
        <Text color={theme.muted}>PLAN · </Text>
        <Text color={theme.ink} bold>{title}  </Text>
        <PlanBar done={done} total={steps.length} now={nowIdx} />
        <Text color={theme.muted}>  {done}/{steps.length}</Text>
        {nowStep && (
          <>
            <Text color={theme.muted}>  ·  </Text>
            <Text color={theme.accent}>{nowStep.label}</Text>
          </>
        )}
      </Box>
    );
  }

  // Card layout for short plans (≤ COMPACT_THRESHOLD steps).
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text color={theme.muted}>PLAN · </Text>
          <Text color={theme.ink} bold>{title}</Text>
        </Text>
        <Text color={theme.muted}>{done} of {steps.length} done</Text>
      </Box>
      <Box flexDirection="row" marginTop={0}>
        {steps.map((s, i) => {
          const isNow  = s.status === 'now';
          const isDone = s.status === 'done';
          const sigil  = isDone ? '✓' : isNow ? '●' : '○';
          const num    = String(i + 1).padStart(2, '0');
          return (
            <Box
              key={i}
              flexDirection="column"
              marginRight={1}
              borderStyle="round"
              borderColor={isNow ? theme.accent : theme.line}
              paddingX={1}
            >
              <Text color={isNow ? theme.accent : theme.muted}>{num} · {sigil}</Text>
              <Text color={isNow ? theme.accent : s.status === 'next' ? theme.muted : theme.inkSoft} bold={isNow}>
                {s.label}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
});
