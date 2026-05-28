import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { ToolProgress as ToolProgressType } from '../types.js';

const TOOL_ICON: Record<string, string> = {
  read_file: '◇', read: '◇',
  write_file: '◆', edit_file: '◆', edit: '◆', apply_patch: '◆',
  exec_shell: '▶', run: '▶',
  grep: '⌕', glob: '⌕', find: '⌕',
  git: '⑂', git_status: '⑂', git_diff: '⑂', git_log: '⑂',
};

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolProgress({ tool }: { tool: ToolProgressType | null }) {
  if (!tool) return <Box />;
  const [elapsed, setElapsed] = useState(Date.now() - tool.startedAt);

  useEffect(() => {
    if (tool.status !== 'running') return;
    const timer = setInterval(() => setElapsed(Date.now() - tool.startedAt), 100);
    return () => clearInterval(timer);
  }, [tool.status, tool.startedAt]);

  const icon = TOOL_ICON[tool.name] ?? '◇';
  const statusColor = tool.status === 'err' ? theme.danger
    : tool.status === 'ok' ? theme.plus
    : theme.accent;

  return (
    <Box paddingLeft={3}>
      <Text color={statusColor}>
        {tool.status === 'running' ? '⟳' : icon}{' '}
      </Text>
      <Text color={theme.ink} bold>{tool.name} </Text>
      <Text color={theme.inkSoft}>{tool.args}</Text>
      <Text color={theme.muted}>  {formatElapsed(elapsed)}</Text>
      {tool.meta ? <Text color={theme.muted}>  {tool.meta}</Text> : null}
    </Box>
  );
}
