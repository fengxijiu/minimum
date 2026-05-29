import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { PipelinePhase } from '../types.js';

/**
 * PipelinePanel — render the W0–W4 orchestrator phases as a horizontal strip,
 * mirroring PlanStrip's look. Active phase is accented; completed phases show a
 * check. Hidden when the pipeline is not running.
 */
export const PipelinePanel = React.memo(function PipelinePanel({ phases }: {
  phases: PipelinePhase[] | null;
}) {
  if (!phases || phases.length === 0) {
    return <Box />;
  }

  const done = phases.filter(p => p.status === 'done').length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text color={theme.muted}>PIPELINE · </Text>
          <Text color={theme.ink} bold>orchestrator</Text>
        </Text>
        <Text color={theme.muted}>{done} of {phases.length} phases</Text>
      </Box>
      <Box flexDirection="row" marginTop={0}>
        {phases.map((p, i) => {
          const isActive = p.status === 'active';
          const isDone = p.status === 'done';
          const sigil = isDone ? '✓' : isActive ? '●' : '○';
          const kickerColor = isActive ? theme.accent : theme.muted;
          const labelColor = isActive ? theme.accent : isDone ? theme.inkSoft : theme.muted;
          return (
            <Box
              key={`${p.phase}-${i}`}
              flexDirection="column"
              marginRight={1}
              borderStyle="round"
              borderColor={isActive ? theme.accent : theme.line}
              paddingX={1}
            >
              <Text color={kickerColor}>{p.phase} · {sigil}</Text>
              <Text color={labelColor} bold={isActive}>{p.label}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
});
