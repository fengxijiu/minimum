import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { ToolProgress as ToolProgressType } from '../types.js';
import { toolIcon } from '../toolIcon.js';

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export const ToolProgress = React.memo(function ToolProgress({ tool }: { tool: ToolProgressType | null }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!tool || tool.status !== 'running') return;
    setElapsed(Date.now() - tool.startedAt);
    const timer = setInterval(() => setElapsed(Date.now() - tool.startedAt), 250);
    return () => clearInterval(timer);
  }, [tool?.id, tool?.status, tool?.startedAt]);

  if (!tool) return null;

  const icon = toolIcon(tool.name);
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
});
