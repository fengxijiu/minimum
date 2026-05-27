import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { TokenMeter } from './atoms.js';
import type { Mode } from '../types.js';

export function StatusBar({ mode, ctxUsed, ctxMax, hint }: {
  mode: Mode;
  ctxUsed: number;
  ctxMax: number;
  hint?: string;
}) {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text backgroundColor={theme.accent} color={theme.bg} bold>
          {' '}{mode}{' '}
        </Text>
        <Text color={theme.muted}>  mimo  </Text>
        <TokenMeter used={ctxUsed} max={ctxMax} />
        <Text color={theme.muted}>  ·  </Text>
        <Text color={theme.ink}>tab</Text>
        <Text color={theme.muted}> mode  </Text>
        <Text color={theme.ink}>esc</Text>
        <Text color={theme.muted}> quit  </Text>
        <Text color={theme.ink}>/</Text>
        <Text color={theme.muted}> cmd  </Text>
        <Text color={theme.ink}>@</Text>
        <Text color={theme.muted}> file</Text>
      </Box>
      <Text color={theme.muted}>{hint ?? '2 staged · main +'}</Text>
    </Box>
  );
}
