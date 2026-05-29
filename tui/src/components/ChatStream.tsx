import React, { useMemo, type ReactNode } from 'react';
import { Box, Static, Text } from 'ink';
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

// ── Markdown rendering ────────────────────────────────────────────────
//
// A small, dependency-free Markdown renderer. Block-level parsing handles
// fenced code, headings, blockquotes, horizontal rules and (nested) lists;
// inline parsing handles bold, italic, code, strikethrough and links.

type MdSpan =
  | { k: 't' | 'b' | 'i' | 'c' | 's'; v: string }
  | { k: 'a'; v: string; href: string };

function parseInlineMd(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  // bold ** **  ·  italic * *  ·  italic _ _  ·  strike ~~ ~~  ·  code ` `  ·  link [t](u)
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) spans.push({ k: 't', v: text.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ k: 'b', v: m[1] });
    else if (m[2] !== undefined) spans.push({ k: 'i', v: m[2] });
    else if (m[3] !== undefined) spans.push({ k: 'i', v: m[3] });
    else if (m[4] !== undefined) spans.push({ k: 's', v: m[4] });
    else if (m[5] !== undefined) spans.push({ k: 'c', v: m[5] });
    else spans.push({ k: 'a', v: m[6]!, href: m[7]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ k: 't', v: text.slice(last) });
  return spans.length ? spans : [{ k: 't', v: text }];
}

function InlineMd({ text, color }: { text: string; color?: string }) {
  const spans = useMemo(() => parseInlineMd(text), [text]);
  return (
    <Text color={color}>
      {spans.map((s, i) => {
        switch (s.k) {
          case 'b': return <Text key={i} bold color={color}>{s.v}</Text>;
          case 'i': return <Text key={i} italic color={color}>{s.v}</Text>;
          case 's': return <Text key={i} strikethrough color={theme.muted}>{s.v}</Text>;
          case 'c': return <Text key={i} color={theme.accent2}>{s.v}</Text>;
          case 'a': return <Text key={i} color={theme.accent} underline>{s.v}</Text>;
          default:  return <Text key={i} color={color}>{s.v}</Text>;
        }
      })}
    </Text>
  );
}

type MdBlock =
  | { k: 'code'; lang: string; lines: string[] }
  | { k: 'heading'; level: 1 | 2 | 3; text: string }
  | { k: 'quote'; text: string }
  | { k: 'hr' }
  | { k: 'li'; indent: number; marker: string; text: string }
  | { k: 'p'; text: string }
  | { k: 'blank' };

function parseBlocks(raw: string): MdBlock[] {
  const out: MdBlock[] = [];
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) { body.push(lines[i]!); i++; }
      i++; // consume closing fence
      out.push({ k: 'code', lang, lines: body });
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.+)/);
    if (h) { out.push({ k: 'heading', level: h[1]!.length as 1 | 2 | 3, text: h[2]! }); i++; continue; }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out.push({ k: 'hr' }); i++; continue; }

    const q = line.match(/^>\s?(.*)/);
    if (q) { out.push({ k: 'quote', text: q[1]! }); i++; continue; }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)/);
    if (li) {
      const indent = Math.min(4, Math.floor(li[1]!.length / 2));
      const marker = /\d/.test(li[2]!) ? li[2]!.replace(/[.)]/, '.') + ' ' : '• ';
      out.push({ k: 'li', indent, marker, text: li[3]! });
      i++; continue;
    }

    if (line.trim() === '') { out.push({ k: 'blank' }); i++; continue; }

    out.push({ k: 'p', text: line }); i++;
  }
  return out;
}

function MarkdownBlock({ text, color }: { text: string; color?: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => {
        switch (b.k) {
          case 'code':
            return (
              <Box
                key={i}
                flexDirection="column"
                borderStyle="round"
                borderColor={theme.line}
                paddingX={1}
              >
                {b.lang ? <Text color={theme.muted}>{b.lang}</Text> : null}
                {(b.lines.length ? b.lines : ['']).map((l, j) => (
                  <Text key={j} color={theme.plus}>{l || ' '}</Text>
                ))}
              </Box>
            );
          case 'heading':
            return (
              <Text
                key={i}
                bold
                color={b.level === 1 ? theme.accent : b.level === 2 ? theme.inkSoft : color}
              >
                {b.text}
              </Text>
            );
          case 'quote':
            return (
              <Box key={i}>
                <Text color={theme.line}>│ </Text>
                <InlineMd text={b.text} color={theme.inkSoft} />
              </Box>
            );
          case 'hr':
            return <Text key={i} color={theme.line}>{'─'.repeat(24)}</Text>;
          case 'li':
            return (
              <Box key={i} paddingLeft={b.indent * 2}>
                <Text color={theme.accent}>{b.marker}</Text>
                <InlineMd text={b.text} color={color} />
              </Box>
            );
          case 'blank':
            return <Text key={i}> </Text>;
          default:
            return (
              <Box key={i}>
                <InlineMd text={b.text} color={color} />
              </Box>
            );
        }
      })}
    </Box>
  );
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
//
// A RenderItem is one printable unit of scrollback. `lastMsgIndex` records
// the highest underlying message index so the stream can be partitioned
// into a committed (Static) prefix and a live tail without breaking the
// turn-divider / tool-grouping logic.

type RenderItem = (
  | { kind: 'msg';       msg: Message }
  | { kind: 'toolgroup'; tools: ToolMsg[] }
  | { kind: 'divider' }
) & { id: string; lastMsgIndex: number };

function buildRenderItems(msgs: Message[]): RenderItem[] {
  const items: RenderItem[] = [];
  let toolBuf: ToolMsg[] = [];
  let toolBufIdx = -1;

  const flushTools = () => {
    if (!toolBuf.length) return;
    items.push({ id: `tg:${toolBuf[0]!.id}`, kind: 'toolgroup', tools: toolBuf, lastMsgIndex: toolBufIdx });
    toolBuf = [];
    toolBufIdx = -1;
  };

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]!;
    if (msg.type === 'tool') {
      toolBuf.push(msg as ToolMsg);
      toolBufIdx = i;
      continue;
    }
    flushTools();
    if (msg.type === 'user' && i > 0) {
      const prev = items[items.length - 1];
      const prevIsMeta = prev?.kind === 'msg' && prev.msg.type === 'turnmeta';
      if (!prevIsMeta) items.push({ id: `div:${msg.id}`, kind: 'divider', lastMsgIndex: i });
    }
    items.push({ id: msg.id, kind: 'msg', msg, lastMsgIndex: i });
  }
  flushTools();
  return items;
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
            <MarkdownBlock text={msg.text} color={theme.ink} />
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
// Claude Code style conversation flow. Completed messages — those in
// [0, committedCount) — are emitted once through <Static>, so the terminal
// writes them into its own scrollback and the user scrolls history with the
// terminal's native scrollback (mouse / trackpad / PgUp). The live tail
// (uncommitted messages of the current turn + the streaming frame) is the
// only region repainted in place.

type StaticEntry =
  | { id: '__header__'; kind: 'header' }
  | RenderItem;

export const ChatStream = React.memo(function ChatStream({
  stepLabel,
  messages,
  committedCount,
  streaming,
  reasoning,
  activeTool,
  verbose,
  cols,
  header,
}: {
  stepLabel?: string;
  messages: Message[];
  committedCount: number;
  streaming?: string | null;
  reasoning?: string | null;
  activeTool?: ToolProgressType | null;
  verbose?: boolean;
  cols: number;
  header?: ReactNode;
}) {
  const allItems = useMemo(() => buildRenderItems(messages), [messages]);

  // Partition into the committed prefix (Static scrollback) and the live tail.
  const { staticEntries, liveItems } = useMemo(() => {
    const committed: RenderItem[] = [];
    const live: RenderItem[] = [];
    for (const it of allItems) {
      if (it.lastMsgIndex < committedCount) committed.push(it);
      else live.push(it);
    }
    const entries: StaticEntry[] = header
      ? [{ id: '__header__', kind: 'header' }, ...committed]
      : committed;
    return { staticEntries: entries, liveItems: live };
  }, [allItems, committedCount, header]);

  // Live streaming frame (the only thing repainted on every token).
  const streamText = streaming ?? '';
  const streamViewport = streamText.split('\n').slice(-STREAM_MAX_LINES).join('\n');
  const hasLive = !!stepLabel || !!activeTool || !!reasoning || !!streamViewport;

  return (
    <Box flexDirection="column">
      {/* ── committed history → terminal scrollback (printed once) ───── */}
      <Static items={staticEntries}>
        {(entry) =>
          entry.kind === 'header'
            ? <Box key="__header__">{header}</Box>
            : <RenderItemRow key={entry.id} item={entry} cols={cols} verbose={verbose} />
        }
      </Static>

      {/* ── live tail of the current turn ───────────────────────────── */}
      {liveItems.map(item => (
        <RenderItemRow key={item.id} item={item} cols={cols} verbose={verbose} />
      ))}

      {/* ── live streaming frame ────────────────────────────────────── */}
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
                <MarkdownBlock text={streamViewport} color={theme.inkSoft} />
                <Text color={theme.muted}>▍</Text>
              </Box>
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
});
