import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export const TitleBar = React.memo(function TitleBar({ path, branch, mode }: {
  path: string;
  branch: string;
  mode: string;
}) {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text color={theme.accent} bold>● </Text>
        <Text color={theme.muted}>○ ○  </Text>
        <Text color={theme.ink} bold>minimum</Text>
        <Text color={theme.muted}> · mimo</Text>
      </Box>
      <Text color={theme.muted}>{path} · {branch} · {mode}</Text>
    </Box>
  );
});
