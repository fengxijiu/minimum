import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { FileEntry } from '../types.js';

export const FilePicker = React.memo(function FilePicker({ items, selected }: {
  items: FileEntry[];
  selected: number;
}) {
  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor={theme.line} paddingX={1}>
        <Text color={theme.muted}>no file matches · </Text>
        <Text color={theme.ink}>esc</Text>
        <Text color={theme.muted}> to dismiss</Text>
      </Box>
    );
  }

  const max = 6;
  const start = Math.min(
    Math.max(0, selected - Math.floor(max / 2)),
    Math.max(0, items.length - max),
  );
  const window = items.slice(start, start + max);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent2} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.accent2} bold>@ files</Text>
        <Text color={theme.muted}>{selected + 1}/{items.length} · ↑↓ · ⏎ insert</Text>
      </Box>
      {window.map((f, i) => {
        const idx = start + i;
        const active = idx === selected;
        return (
          <Box key={f.name}>
            <Text color={active ? theme.bg : theme.accent2} backgroundColor={active ? theme.accent2 : undefined} bold={active}>
              {active ? ' ❯ ' : '   '}{f.name}
            </Text>
            <Text color={theme.muted}>  {f.meta}</Text>
          </Box>
        );
      })}
    </Box>
  );
});
