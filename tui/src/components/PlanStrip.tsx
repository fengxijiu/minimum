import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { PlanStep } from '../types.js';

export function PlanStrip({ title, steps }: {
  title: string;
  steps: PlanStep[];
}) {
  const done = steps.filter(s => s.status === 'done').length;

  if (steps.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color={theme.muted}>PLAN  </Text>
        <Text color={theme.inkSoft}>{title}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text color={theme.muted}>PLAN · </Text>
          <Text color={theme.ink} bold>{title}</Text>
        </Text>
        <Text color={theme.muted}>{done} of {steps.length} done · edit plan</Text>
      </Box>
      <Box flexDirection="row" marginTop={0}>
        {steps.map((s, i) => {
          const isNow  = s.status === 'now';
          const isDone = s.status === 'done';
          const isNext = s.status === 'next';
          const sigil  = isDone ? '✓' : isNow ? '●' : '○';
          const num    = String(i + 1).padStart(2, '0');
          const kickerColor = isNow ? theme.accent : theme.muted;
          const labelColor  = isNow ? theme.accent : isNext ? theme.muted : theme.inkSoft;
          return (
            <Box
              key={i}
              flexDirection="column"
              marginRight={1}
              borderStyle="round"
              borderColor={isNow ? theme.accent : theme.line}
              paddingX={1}
            >
              <Text color={kickerColor}>{num} · {sigil}</Text>
              <Text color={labelColor} bold={isNow}>{s.label}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
