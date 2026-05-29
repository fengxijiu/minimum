import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { HighlightText } from './atoms.js';
import type { CmdMatch, CommandCategory } from '../commands.js';

const CAT_LABEL: Record<CommandCategory, string> = {
  session: 'SESSION',
  context: 'CONTEXT',
  view:    'VIEW',
  system:  'SYSTEM',
};

const MAX_ROWS = 8;

export const CommandPalette = React.memo(function CommandPalette({ items, selected }: {
  items: CmdMatch[];
  selected: number;
}) {
  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor={theme.line} paddingX={1}>
        <Text color={theme.muted}>no matching command  </Text>
        <Text color={theme.ink}>esc</Text>
        <Text color={theme.muted}> dismiss · </Text>
        <Text color={theme.ink}>⇥</Text>
        <Text color={theme.muted}> fill</Text>
      </Box>
    );
  }

  const start = Math.min(
    Math.max(0, selected - Math.floor(MAX_ROWS / 2)),
    Math.max(0, items.length - MAX_ROWS),
  );
  const visible = items.slice(start, start + MAX_ROWS);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      {/* header */}
      <Box justifyContent="space-between">
        <Text color={theme.accent} bold>/ commands</Text>
        <Text color={theme.muted}>
          {selected + 1}/{items.length}  ↑↓ select · ⏎ run · ⇥ fill
        </Text>
      </Box>

      {visible.map(({ cmd, nameMatches, descMatches }, i) => {
        const idx = start + i;
        const active = idx === selected;
        const bg = active ? theme.accent : undefined;
        const fg = active ? theme.bg : theme.accent;

        return (
          <Box key={cmd.name} justifyContent="space-between">
            <Box flexShrink={1}>
              {/* cursor */}
              <Text color={fg} backgroundColor={bg} bold={active}>
                {active ? ' ❯ /' : '   /'}
              </Text>
              {/* command name with highlights */}
              <HighlightText
                text={cmd.name}
                positions={nameMatches}
                color={active ? theme.bg : theme.accent}
                matchColor={active ? theme.bg : theme.warn}
              />
              {/* aliases badge */}
              {cmd.aliases && cmd.aliases.length > 0 && !active && (
                <Text color={theme.muted}>  {cmd.aliases.join(' ')}</Text>
              )}
              {/* description with highlights */}
              <Text color={active ? theme.bg : undefined} backgroundColor={bg}>  </Text>
              <HighlightText
                text={cmd.desc}
                positions={active ? [] : descMatches}
                color={active ? theme.bg : theme.muted}
                matchColor={active ? theme.bg : theme.inkSoft}
              />
              {/* usage hint when active */}
              {active && cmd.usage && (
                <Text color={theme.bg} backgroundColor={bg}>  {cmd.usage}</Text>
              )}
            </Box>
            <Text color={active ? theme.bg : theme.muted} backgroundColor={bg}>
              {'  '}{CAT_LABEL[cmd.category]}
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
