import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from '../theme.js';

export function Prompt({ value, onChange, onSubmit, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <Box paddingX={1} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent} bold>❯ </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={placeholder}
      />
    </Box>
  );
}
