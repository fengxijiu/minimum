import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { ToolCall, Diff, Chip, Permission, ErrorReport } from '../types.js';

const TOOL_ICON: Record<string, string> = {
  read: '◇',
  edit: '◆',
  run:  '▶',
  find: '⌕',
};

export function ToolLine({ tool }: { tool: ToolCall }) {
  const color =
    tool.status === 'err' ? theme.danger :
    tool.kind === 'edit'  ? theme.accent :
    theme.inkSoft;
  return (
    <Box paddingLeft={3}>
      <Text color={color}>{TOOL_ICON[tool.kind] ?? '◇'} </Text>
      <Text color={theme.ink} bold>{tool.kind} </Text>
      <Text color={theme.inkSoft}>{tool.args}</Text>
      {tool.meta ? <Text color={theme.muted}>  {tool.meta}</Text> : null}
    </Box>
  );
}

export function DiffBlock({ diff }: { diff: Diff }) {
  return (
    <Box paddingLeft={3}>
      <Box
        borderStyle="single"
        borderColor={theme.line}
        flexDirection="column"
        paddingX={1}
        flexGrow={1}
      >
        <Box justifyContent="space-between">
          <Text color={theme.inkSoft}>{diff.file}</Text>
          <Text color={theme.muted}>{diff.added}+ {diff.removed}−</Text>
        </Box>
        {!diff.collapsed && diff.lines.map((l, i) => {
          const c = l.startsWith('+') ? theme.plus
                  : l.startsWith('-') ? theme.minus
                  : theme.inkSoft;
          return <Text key={i} color={c}>{l}</Text>;
        })}
      </Box>
    </Box>
  );
}

export function ChipsRow({ chips }: { chips: Chip[] }) {
  return (
    <Box paddingLeft={3} flexDirection="row">
      {chips.map((c, i) => (
        <Box key={i} marginRight={1}>
          {c.primary ? (
            <Text backgroundColor={theme.accent} color={theme.bg} bold>
              {' '}{c.key} {c.label}{' '}
            </Text>
          ) : (
            <Text color={theme.inkSoft}>
              [<Text color={theme.accent}>{c.key}</Text>{' '}{c.label}]
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

export function PermissionCard({ perm }: { perm: Permission }) {
  return (
    <Box paddingLeft={3}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.warn}
        paddingX={1}
        flexGrow={1}
      >
        <Text color={theme.warn} bold>⚠ TOOL · {perm.tool}</Text>
        <Text color={theme.ink}>{perm.cmd}</Text>
        <Text color={theme.muted}>  cwd: {perm.cwd}</Text>
        <Text color={theme.muted}>{perm.note}</Text>
        <Box marginTop={1}>
          <Text backgroundColor={theme.warn} color={theme.bg} bold> ⏎ allow once </Text>
          <Text color={theme.inkSoft}>  [a always]  [n deny]  [e edit]</Text>
        </Box>
      </Box>
    </Box>
  );
}

export function ErrorBlock({ error }: { error: ErrorReport }) {
  return (
    <Box paddingLeft={3}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.danger}
        paddingX={1}
        flexGrow={1}
      >
        <Text color={theme.danger} bold>{error.title}</Text>
        {error.lines.map((l, i) => (
          <Text key={i} color={theme.inkSoft}>{l}</Text>
        ))}
      </Box>
    </Box>
  );
}

export function TokenMeter({ used, max }: { used: number; max: number }) {
  const width = 10;
  const filled = Math.min(width, Math.round((used / max) * width));
  const bar = '▰'.repeat(filled) + '▱'.repeat(width - filled);
  return (
    <Text>
      <Text color={theme.muted}>ctx </Text>
      <Text color={theme.accent}>{bar}</Text>
      <Text color={theme.ink}> {used.toFixed(1)}k</Text>
      <Text color={theme.muted}>/{max}k</Text>
    </Text>
  );
}
