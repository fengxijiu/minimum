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
  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor={theme.line} paddingX={1}>
        <Text color={theme.muted}>no file matches  </Text>
        <Text color={theme.ink}>esc</Text>
        <Text color={theme.muted}> dismiss</Text>
      </Box>
    );
  }

  const start = Math.min(
    Math.max(0, selected - Math.floor(MAX_ROWS / 2)),
    Math.max(0, items.length - MAX_ROWS),
  );
  const visible = items.slice(start, start + MAX_ROWS);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent2} paddingX={1}>
      {/* header */}
      <Box justifyContent="space-between">
        <Text color={theme.accent2} bold>@ files</Text>
        <Text color={theme.muted}>
          {selected + 1}/{items.length}  ↑↓ select · ⏎ insert
        </Text>
      </Box>

      {visible.map(({ file, nameMatches }, i) => {
        const idx = start + i;
        const active = idx === selected;
        const bg = active ? theme.accent2 : undefined;
        const slashIdx = file.name.lastIndexOf('/');
        const dir      = slashIdx >= 0 ? file.name.slice(0, slashIdx + 1) : '';
        const base     = slashIdx >= 0 ? file.name.slice(slashIdx + 1) : file.name;

        // Split nameMatches into dir-part and base-part positions
        const dirMatches  = nameMatches.filter(p => p < slashIdx + 1);
        const baseMatches = nameMatches.filter(p => p >= slashIdx + 1).map(p => p - (slashIdx + 1));

        return (
          <Box key={file.name} justifyContent="space-between">
            <Box>
              <Text color={active ? theme.bg : theme.accent2} backgroundColor={bg} bold={active}>
                {active ? ' ❯ ' : '   '}
              </Text>
              {/* directory prefix — dimmer */}
              {dir ? (
                <HighlightText
                  text={dir}
                  positions={dirMatches}
                  color={active ? theme.bg : theme.muted}
                  matchColor={active ? theme.bg : theme.inkSoft}
                />
              ) : null}
              {/* basename — brighter */}
              <HighlightText
                text={base}
                positions={baseMatches}
                color={active ? theme.bg : theme.ink}
                matchColor={active ? theme.bg : theme.accent2}
              />
            </Box>
            {/* meta (e.g. tool name or last operation) */}
            <Text color={active ? theme.bg : theme.muted} backgroundColor={bg}>
              {'  '}{file.meta}
            </Text>
          </Box>
        );
      })}

      {/* scroll indicators */}
      {items.length > MAX_ROWS && (
        <Box justifyContent="center">
          <Text color={theme.muted}>
            {start > 0 ? '↑ ' : '  '}
            {start + MAX_ROWS < items.length ? '↓' : ' '}
          </Text>
        </Box>
      )}
    </Box>
  );
});
