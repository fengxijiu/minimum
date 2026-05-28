import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../theme.js';
import type { Message } from '../types.js';
import { ToolLine, DiffBlock, ChipsRow, PermissionCard, ErrorBlock } from './atoms.js';

export function ChatStream({ stepLabel, messages }: {
  stepLabel?: string;
  messages: Message[];
}) {
  const { stdout } = useStdout();
  // Reserve rows for: titleBar(1) + planStrip(4) + prompt(3) + statusBar(1) + stepLabel(2) + borders(2)
  const rows = stdout?.rows ?? 40;
  const maxVisible = Math.max(6, rows - 14);
  const clipped = Math.max(0, messages.length - maxVisible);
  const visible = clipped > 0 ? messages.slice(-maxVisible) : messages;

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="single"
      borderColor={theme.line}
      paddingX={1}
    >
      {stepLabel ? (
        <Box marginBottom={1}>
          <Text color={theme.muted}>{stepLabel}</Text>
        </Box>
      ) : null}
      {clipped > 0 && (
        <Box paddingLeft={1}>
          <Text color={theme.muted}>· {clipped} earlier message{clipped === 1 ? '' : 's'} hidden  (/clear to reset)</Text>
        </Box>
      )}

      {visible.map(m => {
        switch (m.type) {
          case 'user':
            return (
              <Box key={m.id} marginTop={1}>
                <Text color={theme.accent} bold>›  </Text>
                <Text color={theme.ink}>{m.text}</Text>
              </Box>
            );
          case 'assistant':
            return (
              <Box key={m.id} marginTop={1}>
                <Text color={theme.ink} bold>◆  </Text>
                <Text color={theme.ink}>{m.text}</Text>
              </Box>
            );
          case 'system': {
            const c = m.tone === 'warn' ? theme.warn
                    : m.tone === 'ok' ? theme.plus
                    : theme.muted;
            return (
              <Box key={m.id} marginTop={1} paddingLeft={3}>
                <Text color={c}>· </Text>
                <Text color={theme.inkSoft}>{m.text}</Text>
              </Box>
            );
          }
          case 'tool':
            return <ToolLine key={m.id} tool={m.tool} />;
          case 'diff':
            return <DiffBlock key={m.id} diff={m.diff} />;
          case 'chips':
            return <ChipsRow key={m.id} chips={m.chips} />;
          case 'permission':
            return <PermissionCard key={m.id} perm={m.perm} />;
          case 'error':
            return <ErrorBlock key={m.id} error={m.error} />;
        }
      })}
    </Box>
  );
}
