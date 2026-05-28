import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { TuiCommand, CommandCategory } from '../commands.js';

const CAT_LABEL: Record<CommandCategory, string> = {
  session: 'SESSION',
  context: 'CONTEXT',
  view: 'VIEW',
  system: 'SYSTEM',
};

export const CommandPalette = React.memo(function CommandPalette({ items, selected }: {
  items: TuiCommand[];
  selected: number;
}) {
  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor={theme.line} paddingX={1}>
        <Text color={theme.muted}>no matching command · </Text>
        <Text color={theme.ink}>esc</Text>
        <Text color={theme.muted}> to dismiss</Text>
      </Box>
    );
  }

  const max = 8;
  const start = Math.min(
    Math.max(0, selected - Math.floor(max / 2)),
    Math.max(0, items.length - max),
  );
  const window = items.slice(start, start + max);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.accent} bold>commands</Text>
        <Text color={theme.muted}>{selected + 1}/{items.length} · ↑↓ move · ⏎ run · ⇥ fill</Text>
      </Box>
      {window.map((c, i) => {
        const idx = start + i;
        const active = idx === selected;
        return (
          <Box key={c.name} justifyContent="space-between">
            <Box>
              <Text color={active ? theme.bg : theme.accent} backgroundColor={active ? theme.accent : undefined} bold={active}>
                {active ? ' ❯ ' : '   '}/{c.name}
              </Text>
              <Text color={theme.muted}>  {c.desc}</Text>
            </Box>
            <Text color={theme.muted}>{CAT_LABEL[c.category]}</Text>
          </Box>
        );
      })}
    </Box>
  );
});
