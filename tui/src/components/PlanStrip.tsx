import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { PlanStep } from '../types.js';

export function PlanStrip({ title, steps }: {
  title: string;
  steps: PlanStep[];
}) {
  const done = steps.filter(s => s.status === 'done').length;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text color={theme.muted}>PLAN  </Text>
          <Text color={theme.ink} bold>{title}</Text>
        </Text>
        <Text color={theme.muted}>{done} of {steps.length} done · edit plan</Text>
      </Box>
      <Box flexDirection="row" marginTop={0}>
        {steps.map((s, i) => {
          const isNow  = s.status === 'now';
          const isDone = s.status === 'done';
          const sigil  = isDone ? '✓' : isNow ? '●' : '○';
          const color  = isNow ? theme.accent : isDone ? theme.inkSoft : theme.muted;
          return (
            <Box
              key={i}
              marginRight={1}
              borderStyle="round"
              borderColor={isNow ? theme.accent : theme.line}
              paddingX={1}
            >
              <Text color={color} bold={isNow}>{sigil} {s.label}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
