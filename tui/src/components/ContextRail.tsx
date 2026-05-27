import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { FileEntry, StagedEdit, Mode } from '../types.js';

const TOOLS = [
  { k: '⌁', n: 'read' },
  { k: '✎', n: 'edit' },
  { k: '▶', n: 'run'  },
  { k: '⌕', n: 'find' },
];

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function ContextRail({ files, edits, mode }: {
  files: FileEntry[];
  edits: StagedEdit[];
  mode: Mode;
}) {
  return (
    <Box
      flexDirection="column"
      width={28}
      flexShrink={0}
      borderStyle="single"
      borderColor={theme.line}
      paddingX={1}
    >
      <Text color={theme.muted}>① CONTEXT · {files.length}</Text>
      {files.map((f, i) => (
        <Box key={i}>
          <Text color={f.staged ? theme.accent : theme.muted}>
            {f.staged ? '●' : '○'}{' '}
          </Text>
          <Text color={theme.ink}>{truncate(f.name, 18)}</Text>
          <Text color={theme.muted}>  {f.meta}</Text>
        </Box>
      ))}

      <Text> </Text>
      <Text color={theme.muted}>② EDITS</Text>
      {edits.map((e, i) => (
        <Box key={i}>
          <Text color={e.sign === '+' ? theme.accent : theme.ink}>
            {e.sign}{' '}
          </Text>
          <Text color={theme.inkSoft}>{truncate(e.label, 22)}</Text>
        </Box>
      ))}

      <Text> </Text>
      <Text color={theme.muted}>③ MODE</Text>
      <Box>
        <Text color={mode === 'agent' ? theme.accent : theme.muted}>
          {mode === 'agent' ? '●' : '○'}{' '}
        </Text>
        <Text color={theme.ink} bold={mode === 'agent'}>agent</Text>
        <Text color={theme.muted}>  auto</Text>
      </Box>
      <Box>
        <Text color={mode === 'chat' ? theme.accent : theme.muted}>
          {mode === 'chat' ? '●' : '○'}{' '}
        </Text>
        <Text color={theme.ink} bold={mode === 'chat'}>chat</Text>
        <Text color={theme.muted}>  step</Text>
      </Box>

      <Text> </Text>
      <Text color={theme.muted}>TOOLS</Text>
      {TOOLS.map((t, i) => (
        <Box key={i}>
          <Text color={theme.muted}>{t.k} </Text>
          <Text color={theme.ink}>{t.n}</Text>
        </Box>
      ))}

      <Text> </Text>
      <Text color={theme.muted}>drop a file in,</Text>
      <Text color={theme.muted}>or type </Text>
      <Text color={theme.accent}>@</Text>
      <Text color={theme.muted}> in the prompt ↘</Text>
    </Box>
  );
}
