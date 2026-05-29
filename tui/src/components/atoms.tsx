import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { ToolCall, Diff, Chip, Permission, ErrorReport, ToolKind } from '../types.js';
import { toolIcon } from '../toolIcon.js';

// ── ToolLine ──────────────────────────────────────────────────────────

const KIND_ICON: Record<ToolKind, string> = {
  read: '◇',
  edit: '◆',
  run:  '▶',
  find: '⌕',
};

const KIND_COLOR: Record<ToolKind, string> = {
  read: theme.muted,
  edit: theme.accent,
  run:  theme.warn,
  find: theme.inkSoft,
};

const OUTPUT_PREVIEW = 12; // lines of tool output shown when expanded

export const ToolLine = React.memo(function ToolLine({ tool, compact, verbose }: { tool: ToolCall; compact?: boolean; verbose?: boolean }) {
  const icon  = KIND_ICON[tool.kind] ?? '◇';
  const color =
    tool.status === 'err' ? theme.danger :
    tool.status === 'ok'  ? KIND_COLOR[tool.kind] :
    KIND_COLOR[tool.kind];
  const metaColor = tool.status === 'ok' ? theme.plus : tool.status === 'err' ? theme.danger : theme.muted;

  // Expand captured output only in verbose mode (default-folded interaction model).
  const out = verbose ? (tool.output ?? []) : [];
  const shown = out.slice(0, OUTPUT_PREVIEW);
  const hidden = out.length - shown.length;
  const pad = compact ? 2 : 4;

  return (
    <Box flexDirection="column">
      <Box paddingLeft={pad}>
        <Text color={color}>{icon} </Text>
        <Text color={theme.inkSoft}>{tool.args}</Text>
        {tool.meta ? <Text color={metaColor}>  {tool.meta}</Text> : null}
      </Box>
      {shown.map((l, i) => (
        <Box key={i} paddingLeft={pad + 2}>
          <Text color={theme.muted}>{l.slice(0, 100)}</Text>
        </Box>
      ))}
      {hidden > 0 && (
        <Box paddingLeft={pad + 2}>
          <Text color={theme.muted}>⋯ {hidden} more line{hidden > 1 ? 's' : ''}</Text>
        </Box>
      )}
    </Box>
  );
});

// ── DiffBlock ─────────────────────────────────────────────────────────

const FOLD_LIMIT   = 18;   // lines before folding
const FOLD_HEAD    = 5;    // lines to keep at top
const FOLD_TAIL    = 4;    // lines to keep at bottom

type LineKind = 'add' | 'remove' | 'hunk' | 'context';

function lineKind(l: string): LineKind {
  if (l.startsWith('@@')) return 'hunk';
  if (l.startsWith('+'))  return 'add';
  if (l.startsWith('-'))  return 'remove';
  return 'context';
}

function lineColor(k: LineKind): string {
  if (k === 'add')    return theme.plus;
  if (k === 'remove') return theme.minus;
  if (k === 'hunk')   return theme.accent2;
  return theme.inkSoft;
}

function linePrefix(k: LineKind): string {
  if (k === 'add')    return '+';
  if (k === 'remove') return '-';
  if (k === 'hunk')   return '⋯';
  return ' ';
}

function DiffLine({ raw }: { raw: string }) {
  const k = lineKind(raw);
  const prefix = linePrefix(k);
  // hunk header: show compactly
  const text = k === 'hunk' ? raw.replace(/^@@[^@]*@@\s*/, '').slice(0, 60) || raw.slice(0, 60) : raw.slice(1);
  return (
    <Text color={lineColor(k)}>
      {prefix} {text}
    </Text>
  );
}

export const DiffBlock = React.memo(function DiffBlock({ diff }: { diff: Diff }) {
  const { lines, collapsed } = diff;

  let display: string[];
  let hiddenCount = 0;

  if (collapsed) {
    display = [];
  } else if (lines.length > FOLD_LIMIT) {
    const head = lines.slice(0, FOLD_HEAD);
    const tail = lines.slice(-FOLD_TAIL);
    hiddenCount = lines.length - FOLD_HEAD - FOLD_TAIL;
    display = [...head, ...tail];
  } else {
    display = lines;
  }

  return (
    <Box paddingLeft={3}>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.line}
        paddingX={1}
        flexGrow={1}
      >
        <Box justifyContent="space-between">
          <Text color={theme.inkSoft}>{diff.file}</Text>
          <Text color={theme.muted}>{diff.added}+ {diff.removed}−{collapsed ? '  (collapsed)' : ''}</Text>
        </Box>

        {display.slice(0, FOLD_HEAD).map((l, i) => <DiffLine key={i} raw={l} />)}

        {hiddenCount > 0 && (
          <Text color={theme.muted}>  ⋯  {hiddenCount} lines  ⋯</Text>
        )}

        {hiddenCount > 0 && display.slice(FOLD_HEAD).map((l, i) => (
          <DiffLine key={`tail-${i}`} raw={l} />
        ))}

        {!hiddenCount && display.slice(FOLD_HEAD).map((l, i) => (
          <DiffLine key={`rest-${i}`} raw={l} />
        ))}
      </Box>
    </Box>
  );
});

// ── ChipsRow ──────────────────────────────────────────────────────────

export const ChipsRow = React.memo(function ChipsRow({ chips }: { chips: Chip[] }) {
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
});

// ── PermissionCard ────────────────────────────────────────────────────

const RISK_COLOR = { high: theme.danger, medium: theme.warn, low: theme.accent } as const;

export const PermissionCard = React.memo(function PermissionCard({ perm }: { perm: Permission }) {
  const risk = perm.risk ?? 'medium';
  const accent = RISK_COLOR[risk];
  return (
    <Box paddingLeft={3}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={accent}
        paddingX={1}
        flexGrow={1}
      >
        <Box justifyContent="space-between">
          <Text color={accent} bold>⚠ TOOL · {perm.tool}</Text>
          <Text backgroundColor={accent} color={theme.bg} bold> risk {risk} </Text>
        </Box>
        <Text color={theme.ink}>{perm.cmd}</Text>

        {/* Full per-parameter breakdown — what's actually being approved. */}
        {perm.details?.length ? (
          <Box flexDirection="column" marginTop={1}>
            {perm.details.map((d, i) => (
              <Text key={i} color={theme.inkSoft}>  · {d}</Text>
            ))}
          </Box>
        ) : null}

        <Text color={theme.muted}>  cwd: {perm.cwd}</Text>
        <Text color={theme.muted}>{perm.note}</Text>
        <Box marginTop={1}>
          <Text backgroundColor={accent} color={theme.bg} bold> ⏎ allow once </Text>
          <Text color={theme.inkSoft}>  [a always]  [n deny]  [e edit]</Text>
        </Box>
      </Box>
    </Box>
  );
});

// ── ErrorBlock ────────────────────────────────────────────────────────

export const ErrorBlock = React.memo(function ErrorBlock({ error }: { error: ErrorReport }) {
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
        {error.context ? (
          <Text color={theme.muted}>while: {error.context}</Text>
        ) : null}
        {error.lines.map((l, i) => (
          <Text key={i} color={theme.inkSoft}>{l}</Text>
        ))}
        {error.hint ? (
          <Box marginTop={1}>
            <Text color={theme.muted}>↳ {error.hint}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
});

// ── TokenMeter ────────────────────────────────────────────────────────

export const TokenMeter = React.memo(function TokenMeter({ used, max }: { used: number; max: number }) {
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
});

// ── HighlightText ─────────────────────────────────────────────────────

export const HighlightText = React.memo(function HighlightText({
  text, positions, color, matchColor,
}: {
  text: string;
  positions: number[];
  color: string;
  matchColor: string;
}) {
  if (!positions.length) return <Text color={color}>{text}</Text>;
  const posSet = new Set(positions);
  type Seg = { t: string; hi: boolean };
  const segs: Seg[] = [];
  for (let i = 0; i < text.length; i++) {
    const hi = posSet.has(i);
    const last = segs[segs.length - 1];
    if (last && last.hi === hi) last.t += text[i];
    else segs.push({ t: text[i]!, hi });
  }
  return (
    <Text>
      {segs.map((s, i) => (
        <Text key={i} color={s.hi ? matchColor : color} bold={s.hi}>{s.t}</Text>
      ))}
    </Text>
  );
});
