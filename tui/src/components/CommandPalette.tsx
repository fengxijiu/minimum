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
  const start = items.length === 0 ? 0 : Math.min(
    Math.max(0, selected - Math.floor(MAX_ROWS / 2)),
    Math.max(0, items.length - MAX_ROWS),
  );
  const visible = items.slice(start, start + MAX_ROWS);

  // Always pad to MAX_ROWS rows — stable height prevents Prompt from shifting
  const rows: Array<CmdMatch | null> = [
    ...visible,
    ...Array(Math.max(0, MAX_ROWS - visible.length)).fill(null),
  ];

  const empty = items.length === 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={empty ? theme.line : theme.accent} paddingX={1}>
      {/* header row */}
      <Box justifyContent="space-between">
        <Text color={empty ? theme.muted : theme.accent} bold>/ commands</Text>
        <Text color={theme.muted}>
          {empty
            ? 'no matches · esc dismiss · ⇥ fill'
            : `${selected + 1}/${items.length}  ↑↓ select · ⏎ run · ⇥ fill`}
        </Text>
      </Box>

      {/* item rows — always exactly MAX_ROWS */}
      {rows.map((item, i) => {
        if (!item) {
          return <Box key={`pad-${i}`}><Text> </Text></Box>;
        }
        const { cmd, nameMatches, descMatches } = item;
        const idx = start + i;
        const active = idx === selected;
        const bg = active ? theme.accent : undefined;
        const fg = active ? theme.bg : theme.accent;

        return (
          <Box key={cmd.name} justifyContent="space-between">
            <Box flexShrink={1}>
              <Text color={fg} backgroundColor={bg} bold={active}>
                {active ? ' ❯ /' : '   /'}
              </Text>
              <HighlightText
                text={cmd.name}
                positions={nameMatches}
                color={active ? theme.bg : theme.accent}
                matchColor={active ? theme.bg : theme.warn}
              />
              {cmd.aliases && cmd.aliases.length > 0 && !active && (
                <Text color={theme.muted}>  {cmd.aliases.join(' ')}</Text>
              )}
              <Text color={active ? theme.bg : undefined} backgroundColor={bg}>  </Text>
              <HighlightText
                text={cmd.desc}
                positions={active ? [] : descMatches}
                color={active ? theme.bg : theme.muted}
                matchColor={active ? theme.bg : theme.inkSoft}
              />
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
