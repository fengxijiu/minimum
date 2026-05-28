import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from '../theme.js';

export const Prompt = React.memo(function Prompt({ value, onChange, onSubmit, placeholder, focus }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  placeholder?: string;
  focus?: boolean;
}) {
  const isCmd = value.startsWith('/');
  return (
    <Box paddingX={1} borderStyle="round" borderColor={isCmd ? theme.accent2 : theme.accent}>
      <Text color={isCmd ? theme.accent2 : theme.accent} bold>❯ </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={placeholder}
        focus={focus ?? true}
      />
    </Box>
  );
});
