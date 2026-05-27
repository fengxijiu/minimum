import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { Message } from '../types.js';
import { ToolLine, DiffBlock, ChipsRow } from './atoms.js';

export function ChatStream({ stepLabel, messages }: {
  stepLabel?: string;
  messages: Message[];
}) {
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

      {messages.map(m => {
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
          case 'tool':
            return <ToolLine key={m.id} tool={m.tool} />;
          case 'diff':
            return <DiffBlock key={m.id} diff={m.diff} />;
          case 'chips':
            return <ChipsRow key={m.id} chips={m.chips} />;
        }
      })}
    </Box>
  );
}
