import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { HighlightText } from './atoms.js';
import type { FileMatch } from '../commands.js';

const MAX_ROWS = 7;

export const FilePicker = React.memo(function FilePicker({ items, selected }: {
  items: FileMatch[];
  selected: number;
}) {
  const start = items.length === 0 ? 0 : Math.min(
    Math.max(0, selected - Math.floor(MAX_ROWS / 2)),
    Math.max(0, items.length - MAX_ROWS),
  );
  const visible = items.slice(start, start + MAX_ROWS);

  // Always pad to MAX_ROWS rows — stable height prevents Prompt from shifting
  const rows: Array<FileMatch | null> = [
    ...visible,
    ...Array(Math.max(0, MAX_ROWS - visible.length)).fill(null),
  ];

  const empty = items.length === 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={empty ? theme.line : theme.accent2} paddingX={1}>
      {/* header row */}
      <Box justifyContent="space-between">
        <Text color={empty ? theme.muted : theme.accent2} bold>@ files</Text>
        <Text color={theme.muted}>
          {empty
            ? 'no matches · esc dismiss'
            : `${selected + 1}/${items.length}  ↑↓ select · ⏎ insert`}
        </Text>
      </Box>

      {/* item rows — always exactly MAX_ROWS */}
      {rows.map((item, i) => {
        if (!item) {
          return <Box key={`pad-${i}`}><Text> </Text></Box>;
        }
        const { file, nameMatches } = item;
        const idx = start + i;
        const active = idx === selected;
        const bg = active ? theme.accent2 : undefined;
        const slashIdx = file.name.lastIndexOf('/');
        const dir      = slashIdx >= 0 ? file.name.slice(0, slashIdx + 1) : '';
        const base     = slashIdx >= 0 ? file.name.slice(slashIdx + 1) : file.name;

        const dirMatches  = nameMatches.filter(p => p < slashIdx + 1);
        const baseMatches = nameMatches.filter(p => p >= slashIdx + 1).map(p => p - (slashIdx + 1));

        return (
          <Box key={file.name} justifyContent="space-between">
            <Box>
              <Text color={active ? theme.bg : theme.accent2} backgroundColor={bg} bold={active}>
                {active ? ' ❯ ' : '   '}
              </Text>
              {dir ? (
                <HighlightText
                  text={dir}
                  positions={dirMatches}
                  color={active ? theme.bg : theme.muted}
                  matchColor={active ? theme.bg : theme.inkSoft}
                />
              ) : null}
              <HighlightText
                text={base}
                positions={baseMatches}
                color={active ? theme.bg : theme.ink}
                matchColor={active ? theme.bg : theme.accent2}
              />
            </Box>
            <Text color={active ? theme.bg : theme.muted} backgroundColor={bg}>
              {'  '}{file.meta}
            </Text>
          </Box>
        );
      })}

      {/* scroll indicator row — always present for stable height */}
      <Box justifyContent="center">
        <Text color={theme.muted}>
          {items.length > MAX_ROWS && start > 0 ? '↑ ' : '  '}
          {items.length > MAX_ROWS && start + MAX_ROWS < items.length ? '↓' : ' '}
        </Text>
      </Box>
    </Box>
  );
});
