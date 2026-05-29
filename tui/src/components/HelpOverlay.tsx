import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { COMMANDS, type CommandCategory } from '../commands.js';

const KEYS: Array<[string, string]> = [
  ['/', 'command palette'],
  ['@', 'file picker'],
  ['tab', 'cycle mode (agent/chat/orch)'],
  ['↑ ↓', 'navigate palette'],
  ['⏎', 'run / send'],
  ['esc', 'close overlay / quit'],
  ['?', 'this help'],
];

const ORDER: CommandCategory[] = ['session', 'context', 'view', 'system'];
const CAT_LABEL: Record<CommandCategory, string> = {
  session: 'SESSION', context: 'CONTEXT', view: 'VIEW', system: 'SYSTEM',
};

export const HelpOverlay = React.memo(function HelpOverlay() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={theme.accent} bold>minimum · help</Text>
        <Text color={theme.muted}>esc / ⏎ to close</Text>
      </Box>

      <Text color={theme.muted}>KEYS</Text>
      <Box flexDirection="row" flexWrap="wrap">
        {KEYS.map(([k, d]) => (
          <Box key={k} marginRight={2}>
            <Text color={theme.accent} bold>{k}</Text>
            <Text color={theme.inkSoft}> {d}</Text>
          </Box>
        ))}
      </Box>

      <Text> </Text>
      {ORDER.map(cat => (
        <Box key={cat} flexDirection="column">
          <Text color={theme.muted}>{CAT_LABEL[cat]}</Text>
          <Box flexDirection="row" flexWrap="wrap">
            {COMMANDS.filter(c => c.category === cat).map(c => (
              <Box key={c.name} marginRight={2}>
                <Text color={theme.accent}>/{c.name}</Text>
                <Text color={theme.muted}> {c.desc}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
});
