import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

const LOGO = [
  '  __  ___   __  ',
  ' /  |/  /  / /   minimum',
  '/ /|_/ /  / /    interactive coding · mimo',
  '\\/  /_/  /_/     v0.1 · ~/proj/api',
];

const SUGGESTED = [
  'explain this repo',
  "find tests that don't pass",
  'summarize recent commits',
];

export function WelcomeScreen() {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="single"
      borderColor={theme.line}
      paddingX={2}
      paddingY={1}
    >
      {LOGO.map((line, i) => (
        <Text key={i} color={theme.accent} bold>{line}</Text>
      ))}

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted}>QUICK START</Text>
        <Text color={theme.inkSoft}>· type a request — <Text color={theme.muted}>"add a /health endpoint"</Text></Text>
        <Text color={theme.inkSoft}>· <Text color={theme.accent}>@</Text> to bring a file into context</Text>
        <Text color={theme.inkSoft}>· <Text color={theme.accent}>/</Text> for commands · <Text color={theme.accent}>?</Text> for help</Text>
        <Text color={theme.inkSoft}>· press <Text color={theme.accent}>tab</Text> to flip <Text color={theme.muted}>chat ↔ agent</Text></Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted}>SUGGESTED</Text>
        {SUGGESTED.map((s, i) => (
          <Box key={i}>
            <Text color={theme.accent}>› </Text>
            <Text color={theme.ink}>{s}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
