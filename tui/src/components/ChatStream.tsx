import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../theme.js';
import type { Message } from '../types.js';
import { ToolLine, DiffBlock, ChipsRow, PermissionCard, ErrorBlock } from './atoms.js';

/** Memoized single message renderer — avoids re-rendering unchanged messages. */
const MessageRow = React.memo(function MessageRow({ msg }: { msg: Message }) {
  switch (msg.type) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={theme.accent} bold>›  </Text>
          <Text color={theme.ink}>{msg.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Text color={theme.ink} bold>◆  </Text>
          <Text color={theme.ink}>{msg.text}</Text>
        </Box>
      );
    case 'system': {
      const c = msg.tone === 'warn' ? theme.warn
              : msg.tone === 'ok' ? theme.plus
              : theme.muted;
      return (
        <Box marginTop={1} paddingLeft={3}>
          <Text color={c}>· </Text>
          <Text color={theme.inkSoft}>{msg.text}</Text>
        </Box>
      );
    }
    case 'tool':
      return <ToolLine tool={msg.tool} />;
    case 'diff':
      return <DiffBlock diff={msg.diff} />;
    case 'chips':
      return <ChipsRow chips={msg.chips} />;
    case 'permission':
      return <PermissionCard perm={msg.perm} />;
    case 'error':
      return <ErrorBlock error={msg.error} />;
    default:
      return null;
  }
});

export const ChatStream = React.memo(function ChatStream({ stepLabel, messages, streaming }: {
  stepLabel?: string;
  messages: Message[];
  streaming?: string | null;
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

      {visible.map(m => <MessageRow key={m.id} msg={m} />)}

      {streaming ? (
        <Box marginTop={1}>
          <Text color={theme.ink} bold>◆  </Text>
          <Text color={theme.inkSoft}>{streaming}</Text>
          <Text color={theme.muted}>▍</Text>
        </Box>
      ) : null}
    </Box>
  );
});
