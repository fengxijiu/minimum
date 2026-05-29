import React, { useRef } from 'react';
import { Box, Text, Static, useStdout } from 'ink';
import { theme } from '../theme.js';
import type { Message } from '../types.js';
import { ToolLine, DiffBlock, ChipsRow, PermissionCard, ErrorBlock } from './atoms.js';

// ── Layout constants ──────────────────────────────────────────────────
const CHROME_ROWS    = 14;
const STREAM_MAX_LINES = 8;

// ── Role visual system (Module A) ─────────────────────────────────────

/**
 * Left accent bar for user / assistant messages.
 * system / tool messages intentionally have no gutter — they're supporting
 * cast and should visually recede.
 */
function RoleGutter({ color }: { color: string }) {
  return <Text color={color}>▎ </Text>;
}

function RoleLabel({ label, color }: { label: string; color: string }) {
  return <Text color={color} bold>{label}  </Text>;
}

// ── Tool group rendering (Module C) ──────────────────────────────────

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

// ── Turn divider (Module E) ───────────────────────────────────────────

function TurnDivider({ cols }: { cols: number }) {
  const w = Math.max(4, cols - 4);
  return (
    <Box marginTop={1}>
      <Text color={theme.line}>{'─'.repeat(w)}</Text>
    </Box>
  );
}

/** Informative end-of-turn rule: ──── 4 steps · 7 tools · 1.2k tok · $0.03 ──── */
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

/** Folded reasoning indicator shown in the live frame while the model thinks. */
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

/**
 * Build the render item list from a flat message array:
 *  - Adjacent tool messages → single ToolGroupRow
 *  - user message after non-user → TurnDivider inserted before it
 */
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
      // A turnmeta rule already serves as the boundary — don't stack a plain divider on it.
      const prev = items[items.length - 1];
      const prevIsMeta = prev?.kind === 'msg' && prev.msg.type === 'turnmeta';
      if (!prevIsMeta) items.push({ id: `div:${msg.id}`, kind: 'divider' });
    }
    items.push({ id: msg.id, kind: 'msg', msg });
  }
  flushTools();
  return items;
}

// ── Single message renderer ───────────────────────────────────────────

const MessageRow = React.memo(function MessageRow({ msg, cols, verbose }: { msg: Message; cols: number; verbose?: boolean }) {
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

export const ChatStream = React.memo(function ChatStream({
  stepLabel,
  messages,
  committedCount,
  streaming,
  reasoning,
  verbose,
}: {
  stepLabel?: string;
  messages: Message[];
  committedCount: number;
  streaming?: string | null;
  reasoning?: string | null;
  verbose?: boolean;
}) {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 40;
  const cols = stdout?.columns ?? 80;

  // ── Stable committed items for <Static> ───────────────────────────
  // Recomputed only when committedCount advances (turn ends).
  const lastCountRef   = useRef(0);
  const committedItemsRef = useRef<RenderItem[]>([]);

  if (committedCount !== lastCountRef.current) {
    lastCountRef.current = committedCount;
    committedItemsRef.current = buildRenderItems(messages.slice(0, committedCount));
  }
  const committedItems = committedItemsRef.current;

  // ── Live tail (current turn) ──────────────────────────────────────
  const live = messages.slice(committedCount);

  // Clip live messages so the active frame never exceeds terminal height.
  const activeHeight = Math.max(8, rows - CHROME_ROWS);
  const maxLive = Math.max(4, Math.floor((activeHeight - STREAM_MAX_LINES) / 2));
  const clippedLive = Math.max(0, live.length - maxLive);
  const visibleLive = clippedLive > 0 ? live.slice(-maxLive) : live;
  const liveItems = buildRenderItems(visibleLive);

  // Cap streaming viewport.
  const streamText = streaming ?? '';
  const streamViewport = streamText.split('\n').slice(-STREAM_MAX_LINES).join('\n');

  return (
    <>
      {/* Phase 2: committed messages rendered once, never redrawn. */}
      <Static items={committedItems}>
        {(item) => <RenderItemRow key={item.id} item={item} cols={cols} verbose={verbose} />}
      </Static>

      {/* Active frame: current-turn live messages + streaming cursor. */}
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

        {liveItems.map(item => (
          <RenderItemRow key={item.id} item={item} cols={cols} verbose={verbose} />
        ))}

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
    </>
  );
});
