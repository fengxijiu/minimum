import React from 'react';
import { Box, Text, Static, useStdout } from 'ink';
import { theme } from '../theme.js';
import type { Message } from '../types.js';
import { ToolLine, DiffBlock, ChipsRow, PermissionCard, ErrorBlock } from './atoms.js';

// Rows consumed by chrome outside the chat area:
//   TitleBar(1) + PlanStrip(0–5) + PipelinePanel(0–3) + ToolProgress(2) +
//   StatusBar(1) + InputArea(3) + ChatStream borders(2) + margins(2)
const CHROME_ROWS = 14;

// Max lines of streaming text to show (prevents height churn as tokens grow).
const STREAM_MAX_LINES = 8;

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

export const ChatStream = React.memo(function ChatStream({
  stepLabel,
  messages,
  committedCount,
  streaming,
}: {
  stepLabel?: string;
  messages: Message[];
  committedCount: number;
  streaming?: string | null;
}) {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 40;

  // ── Split: committed (Static, printed once) vs live (active frame) ──
  const committed = messages.slice(0, committedCount);
  const live = messages.slice(committedCount);

  // Clip the live tail so the active frame never exceeds terminal height.
  // Each message is ~2 rows (marginTop + content); reserve STREAM_MAX_LINES for streaming.
  const activeHeight = Math.max(8, rows - CHROME_ROWS);
  const maxLive = Math.max(4, Math.floor((activeHeight - STREAM_MAX_LINES) / 2));
  const clippedLive = Math.max(0, live.length - maxLive);
  const visibleLive = clippedLive > 0 ? live.slice(-maxLive) : live;

  // Cap streaming text to a fixed number of lines to prevent height jitter.
  const streamText = streaming ?? '';
  const streamViewport = streamText.split('\n').slice(-STREAM_MAX_LINES).join('\n');

  return (
    <>
      {/* Phase 2: committed messages rendered exactly once, never redrawn. */}
      <Static items={committed}>
        {(msg) => <MessageRow key={msg.id} msg={msg} />}
      </Static>

      {/* Active frame: only current-turn live messages + streaming cursor. */}
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

        {clippedLive > 0 && (
          <Box paddingLeft={1}>
            <Text color={theme.muted}>
              · {clippedLive} earlier message{clippedLive === 1 ? '' : 's'} hidden
            </Text>
          </Box>
        )}

        {visibleLive.map(m => <MessageRow key={m.id} msg={m} />)}

        {streamViewport ? (
          <Box marginTop={1}>
            <Text color={theme.ink} bold>◆  </Text>
            <Text color={theme.inkSoft}>{streamViewport}</Text>
            <Text color={theme.muted}>▍</Text>
          </Box>
        ) : null}
      </Box>
    </>
  );
});
