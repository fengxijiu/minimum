import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { Message, ToolProgress as ToolProgressType } from '../types.js';
import { ToolLine, DiffBlock, ChipsRow, PermissionCard, ErrorBlock } from './atoms.js';

const STREAM_MAX_LINES = 8;

// ── Role visual system ────────────────────────────────────────────────

function RoleGutter({ color }: { color: string }) {
  return <Text color={color}>▎ </Text>;
}

function RoleLabel({ label, color }: { label: string; color: string }) {
  return <Text color={color} bold>{label}  </Text>;
}

// ── Tool group rendering ──────────────────────────────────────────────

type ToolMsg = Message & { type: 'tool' };

function ToolGroupRow({ tools, verbose }: { tools: ToolMsg[]; verbose?: boolean }) {
  const edits  = tools.filter(t => t.tool.kind === 'edit').length;
  const runs   = tools.filter(t => t.tool.kind === 'run').length;
  const reads  = tools.filter(t => t.tool.kind === 'read').length;
  const finds  = tools.filter(t => t.tool.kind === 'find').length;
  const errors = tools.filter(t => t.tool.status === 'err').length;

  const parts: string[] = [];
  if (edits) parts.push(`${edits} edit${edits > 1 ? 's' : ''}`);
  if (runs)  parts.push(`${runs} run${runs > 1 ? 's' : ''}`);
  if (reads) parts.push(`${reads} read${reads > 1 ? 's' : ''}`);
  if (finds) parts.push(`${finds} find${finds > 1 ? 's' : ''}`);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingLeft={2}>
        <Text color={theme.muted}>
          {'⌗ '}
          <Text color={errors ? theme.danger : theme.inkSoft}>
            {tools.length} tool{tools.length > 1 ? 's' : ''}{parts.length ? `  ·  ${parts.join(' · ')}` : ''}
            {errors > 0 ? `  ·  ${errors} failed` : ''}
          </Text>
        </Text>
      </Box>
      {tools.map(t => <ToolLine key={t.id} tool={t.tool} compact verbose={verbose} />)}
    </Box>
  );
}

// ── Turn divider ──────────────────────────────────────────────────────

function TurnDivider({ cols }: { cols: number }) {
  const w = Math.max(4, cols - 4);
  return (
    <Box marginTop={1}>
      <Text color={theme.line}>{'─'.repeat(w)}</Text>
    </Box>
  );
}

function TurnMetaRule({ summary, cols }: { summary: string; cols: number }) {
  const label = ` ${summary} `;
  const rest = Math.max(2, cols - 4 - label.length);
  const left = Math.floor(rest / 2);
  const right = rest - left;
  return (
    <Box marginTop={1}>
      <Text color={theme.line}>{'─'.repeat(left)}</Text>
      <Text color={theme.muted}>{label}</Text>
      <Text color={theme.line}>{'─'.repeat(right)}</Text>
    </Box>
  );
}

function ReasoningRow({ text, verbose }: { text: string; verbose?: boolean }) {
  const lines = text.split('\n').filter(l => l.trim() !== '');
  const tail = verbose ? lines.slice(-6) : lines.slice(-1);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingLeft={2}>
        <Text color={theme.accent2}>◇ </Text>
        <Text color={theme.muted}>thinking · {lines.length} line{lines.length === 1 ? '' : 's'}{verbose ? '' : '  (verbose to expand)'}</Text>
      </Box>
      {tail.map((l, i) => (
        <Box key={i} paddingLeft={4}>
          <Text color={theme.muted} dimColor>{l.slice(0, 100)}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ── Render item types ─────────────────────────────────────────────────

type RenderItem =
  | { id: string; kind: 'msg';       msg: Message }
  | { id: string; kind: 'toolgroup'; tools: ToolMsg[] }
  | { id: string; kind: 'divider' };

function buildRenderItems(msgs: Message[]): RenderItem[] {
  const items: RenderItem[] = [];
  let toolBuf: ToolMsg[] = [];

  const flushTools = () => {
    if (!toolBuf.length) return;
    items.push({ id: `tg:${toolBuf[0]!.id}`, kind: 'toolgroup', tools: toolBuf });
    toolBuf = [];
  };

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]!;
    if (msg.type === 'tool') {
      toolBuf.push(msg as ToolMsg);
      continue;
    }
    flushTools();
    if (msg.type === 'user' && i > 0) {
      const prev = items[items.length - 1];
      const prevIsMeta = prev?.kind === 'msg' && prev.msg.type === 'turnmeta';
      if (!prevIsMeta) items.push({ id: `div:${msg.id}`, kind: 'divider' });
    }
    items.push({ id: msg.id, kind: 'msg', msg });
  }
  flushTools();
  return items;
}

// ── Height estimation (for virtual scroll) ────────────────────────────

function estimateItemHeight(item: RenderItem, cols: number): number {
  const w = Math.max(20, cols - 6);
  if (item.kind === 'divider') return 2;
  if (item.kind === 'toolgroup') return 2 + item.tools.length;
  const msg = item.msg;
  switch (msg.type) {
    case 'user': {
      const lines = msg.text.split('\n').reduce((acc, l) =>
        acc + Math.max(1, Math.ceil(l.length / w)), 0);
      return 2 + lines;
    }
    case 'assistant': {
      const lines = msg.text.split('\n').reduce((acc, l) =>
        acc + Math.max(1, Math.ceil(l.length / w)), 0);
      return 2 + lines;
    }
    case 'system':     return 2; // <Box marginTop={1}> + 1 content row
    case 'tool':       return 1;
    case 'turnmeta':   return 2;
    case 'error':      return 3 + Math.min(6, msg.error.lines?.length ?? 0);
    case 'diff':       return 3 + Math.min(12, msg.diff.lines?.length ?? 0);
    case 'chips':      return 2;
    case 'permission': return 7;
    default:           return 2;
  }
}

// ── Viewport calculator ───────────────────────────────────────────────

function buildViewport(
  items: RenderItem[],
  viewportH: number,
  scrollOffset: number,
  cols: number,
): { visible: RenderItem[]; linesAbove: number; totalLines: number } {
  if (viewportH <= 0 || items.length === 0) {
    return { visible: [], linesAbove: 0, totalLines: 0 };
  }

  const heights = items.map(it => Math.max(1, estimateItemHeight(it, cols)));
  const totalLines = heights.reduce((a, b) => a + b, 0);

  if (totalLines <= viewportH) {
    return { visible: items, linesAbove: 0, totalLines };
  }

  // bottomEdge = the last line index (0-based) we want to show
  const clampedOffset = Math.max(0, Math.min(scrollOffset, totalLines - viewportH));
  const bottomEdge = totalLines - clampedOffset;
  const topEdge = Math.max(0, bottomEdge - viewportH);

  let cum = 0;
  const visible: RenderItem[] = [];
  let linesAbove = 0;

  for (let i = 0; i < items.length; i++) {
    const h = heights[i]!;
    const end = cum + h;
    if (end <= topEdge) {
      linesAbove += h;
    } else if (cum >= topEdge + viewportH) {
      break;
    } else {
      visible.push(items[i]!);
    }
    cum += h;
  }

  return { visible, linesAbove, totalLines };
}

// ── Single message renderer ───────────────────────────────────────────

const MessageRow = React.memo(function MessageRow({ msg, cols, verbose }: {
  msg: Message; cols: number; verbose?: boolean;
}) {
  switch (msg.type) {
    case 'user':
      return (
        <Box marginTop={1}>
          <RoleGutter color={theme.accent} />
          <Box flexDirection="column" flexGrow={1}>
            <RoleLabel label="you" color={theme.accent} />
            <Text color={theme.ink}>{msg.text}</Text>
          </Box>
        </Box>
      );

    case 'assistant':
      return (
        <Box marginTop={1}>
          <RoleGutter color={theme.inkSoft} />
          <Box flexDirection="column" flexGrow={1}>
            <RoleLabel label="mimo" color={theme.inkSoft} />
            <Text color={theme.ink}>{msg.text}</Text>
          </Box>
        </Box>
      );

    case 'system': {
      const c = msg.tone === 'warn' ? theme.warn
              : msg.tone === 'ok'   ? theme.plus
              : theme.muted;
      return (
        <Box marginTop={1} paddingLeft={3}>
          <Text color={c}>· </Text>
          <Text color={theme.inkSoft}>{msg.text}</Text>
        </Box>
      );
    }

    case 'tool':
      return <ToolLine tool={msg.tool} verbose={verbose} />;

    case 'turnmeta':
      return <TurnMetaRule summary={msg.summary} cols={cols} />;

    case 'diff':
      return <DiffBlock diff={msg.diff} />;

    case 'chips':
      return <ChipsRow chips={msg.chips} />;

    case 'permission':
      return <PermissionCard perm={msg.perm} />;

    case 'error':
      return (
        <Box marginTop={1}>
          <RoleGutter color={theme.danger} />
          <Box flexDirection="column" flexGrow={1}>
            <RoleLabel label="error" color={theme.danger} />
            <ErrorBlock error={msg.error} />
          </Box>
        </Box>
      );

    default:
      return null;
  }
});

// ── Render item dispatcher ────────────────────────────────────────────

function RenderItemRow({ item, cols, verbose }: { item: RenderItem; cols: number; verbose?: boolean }) {
  if (item.kind === 'divider') return <TurnDivider cols={cols} />;
  if (item.kind === 'toolgroup') return <ToolGroupRow tools={item.tools} verbose={verbose} />;
  return <MessageRow msg={item.msg} cols={cols} verbose={verbose} />;
}

// ── ChatStream ────────────────────────────────────────────────────────
//
// Full-viewport chat area. No <Static>: every message lives in the live
// region, and a virtual-scroll window selects which items to render.
// scrollOffset=0 pins to the bottom (latest messages); positive values
// scroll upward through history.

export const ChatStream = React.memo(function ChatStream({
  stepLabel,
  messages,
  streaming,
  reasoning,
  activeTool,
  verbose,
  scrollOffset,
  chatHeight,
  cols,
}: {
  stepLabel?: string;
  messages: Message[];
  streaming?: string | null;
  reasoning?: string | null;
  activeTool?: ToolProgressType | null;
  verbose?: boolean;
  scrollOffset: number;
  chatHeight: number;
  cols: number;
}) {
  const allItems = useMemo(() => buildRenderItems(messages), [messages]);

  // Estimate live-frame height so we don't let it crowd the history pane.
  const streamText = streaming ?? '';
  const streamViewport = streamText.split('\n').slice(-STREAM_MAX_LINES).join('\n');
  const hasLive = !!stepLabel || !!activeTool || !!reasoning || !!streamViewport;

  const liveH = hasLive
    ? 2                                           // border top+bottom
    + (stepLabel ? 1 : 0)
    + (activeTool ? 1 : 0)
    + (reasoning ? (verbose ? 4 : 2) : 0)
    + (streamViewport ? 3 : 0)
    : 0;

  // One row for the scroll indicator, reserved whenever there are items above.
  const indicatorH = 1;
  const historyH = Math.max(4, chatHeight - liveH - indicatorH);

  const { visible, linesAbove, totalLines } = useMemo(
    () => buildViewport(allItems, historyH, scrollOffset, cols),
    [allItems, historyH, scrollOffset, cols],
  );

  const isScrolled = scrollOffset > 0;
  const canScrollDown = isScrolled;

  return (
    <Box flexDirection="column" flexGrow={1}>

      {/* ── scroll-up indicator ─────────────────────────────────────── */}
      {linesAbove > 0 ? (
        <Box paddingLeft={2}>
          <Text color={theme.muted}>
            {'↑ '}
            <Text color={theme.inkSoft}>{Math.round(linesAbove / 2)}</Text>
            {' messages above · '}
            <Text color={theme.accent}>PgUp</Text>
          </Text>
        </Box>
      ) : (
        // Always keep one blank indicator row so the layout height is stable.
        <Box paddingLeft={2}><Text> </Text></Box>
      )}

      {/* ── visible history ─────────────────────────────────────────── */}
      {visible.map(item => (
        <RenderItemRow key={item.id} item={item} cols={cols} verbose={verbose} />
      ))}

      {/* ── scroll-down indicator (shown when scrolled up) ──────────── */}
      {canScrollDown ? (
        <Box paddingLeft={2} marginTop={1}>
          <Text color={theme.muted}>
            {'↓ '}
            {hasLive
              ? <Text color={theme.accent}>turn in progress</Text>
              : <Text color={theme.inkSoft}>latest messages</Text>}
            {' · '}
            <Text color={theme.accent}>PgDn</Text>
          </Text>
        </Box>
      ) : null}

      {/* ── live frame ──────────────────────────────────────────────── */}
      {hasLive ? (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor={theme.line}
          paddingX={1}
          marginTop={1}
        >
          {stepLabel ? (
            <Box marginBottom={1}>
              <Text color={theme.muted}>{stepLabel}</Text>
            </Box>
          ) : null}

          {activeTool ? (
            <Box paddingLeft={1}>
              <Text color={
                activeTool.status === 'err' ? theme.danger
                : activeTool.status === 'ok' ? theme.plus
                : theme.accent
              }>
                {activeTool.status === 'running' ? '⟳' : activeTool.status === 'ok' ? '✓' : '✗'}{' '}
              </Text>
              <Text color={theme.ink} bold>{activeTool.name} </Text>
              <Text color={theme.inkSoft}>{activeTool.args}</Text>
            </Box>
          ) : null}

          {reasoning ? <ReasoningRow text={reasoning} verbose={verbose} /> : null}

          {streamViewport ? (
            <Box marginTop={1}>
              <RoleGutter color={theme.inkSoft} />
              <Box flexDirection="column" flexGrow={1}>
                <RoleLabel label="mimo" color={theme.inkSoft} />
                <Text color={theme.inkSoft}>{streamViewport}</Text>
                <Text color={theme.muted}>▍</Text>
              </Box>
            </Box>
          ) : null}
        </Box>
      ) : null}

    </Box>
  );
});
