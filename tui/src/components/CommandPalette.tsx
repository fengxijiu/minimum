import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { HighlightText } from './atoms.js';
import type { CmdMatch, CommandCategory } from '../commands.js';

const CAT_LABEL: Record<CommandCategory, string> = {
  session: 'SESSION',
  context: 'CONTEXT',
  view: 'VIEW',
  system: 'SYSTEM',
};

const MAX_ROWS = 8;

export const CommandPalette = React.memo(function CommandPalette({ items, selected }: {
  items: CmdMatch[];
  selected: number;
}) {
  const start = items.length === 0 ? 0 : Math.min(
    Math.max(0, selected - Math.floor(MAX_ROWS / 2)),
    Math.max(0, items.length - MAX_ROWS),
  );
  const visible = items.slice(start, start + MAX_ROWS);
  const padded = [...visible, ...Array.from({ length: Math.max(0, MAX_ROWS - visible.length) }, () => null)];
  const empty = items.length === 0;
  const hasScroll = items.length > MAX_ROWS;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={empty ? theme.line : theme.accent} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={empty ? theme.muted : theme.accent} bold>/ commands</Text>
        <Text color={theme.muted}>
          {empty
            ? 'no matches • esc close • tab fill'
            : `${selected + 1}/${items.length}  ↑↓ select • enter run • tab fill`}
        </Text>
      </Box>

      {empty ? (
        <>
          <Text color={theme.muted}>  Type to filter commands</Text>
          {Array.from({ length: MAX_ROWS - 1 }).map((_, index) => <Text key={`empty-${index}`}> </Text>)}
        </>
      ) : padded.map((item, i) => {
        if (!item) return <Text key={`pad-${i}`}> </Text>;

        const { cmd, nameMatches, descMatches } = item;
        const idx = start + i;
        const active = idx === selected;
        const commandBg = active ? theme.accent : undefined;
        const commandFg = active ? theme.bg : theme.accent;

        return (
          <Box key={cmd.name} justifyContent="space-between">
            <Box flexShrink={1}>
              <Text color={active ? theme.accent : theme.muted} bold={active}>
                {active ? ' > ' : '   '}
              </Text>
              <Text color={commandFg} backgroundColor={commandBg} bold={active}>/</Text>
              <HighlightText
                text={cmd.name}
                positions={nameMatches}
                color={commandFg}
                matchColor={active ? theme.bg : theme.warn}
                backgroundColor={commandBg}
              />
              <Text color={theme.muted}>  - </Text>
              <HighlightText
                text={cmd.desc}
                positions={active ? [] : descMatches}
                color={active ? theme.ink : theme.muted}
                matchColor={theme.inkSoft}
              />
            </Box>
            <Text color={active ? theme.accent : theme.muted} bold={active}>
              {'  '}{CAT_LABEL[cmd.category]}
            </Text>
          </Box>
        );
      })}

      <Box justifyContent="center">
        <Text color={theme.muted}>
          {hasScroll && start > 0 ? '^' : ' '}
          {hasScroll && start + MAX_ROWS < items.length ? 'v' : ' '}
        </Text>
      </Box>
    </Box>
  );
});
