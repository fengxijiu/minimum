import React, { useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../theme.js';
import type { PipelinePhase } from '../types.js';
import { STAGE_ORDER, stageDisplay } from '../../../dist/orchestration/StageDisplay.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAME_MS = 250;

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

type StageStatus = PipelinePhase['status'];

interface StageView {
  code: string;
  name: string;
  description: string;
  status: StageStatus;
  startedAt?: number;
  endedAt?: number;
  detail?: string;
}

function glyph(status: StageStatus, tick: number): string {
  if (status === 'done') return '✓';
  if (status === 'err') return '✗';
  if (status === 'active') return SPINNER[tick % SPINNER.length]!;
  return '○';
}

function stageColor(status: StageStatus): string {
  if (status === 'active') return theme.accent;
  if (status === 'err') return theme.danger;
  if (status === 'done') return theme.plus;
  return theme.muted;
}

function labelColor(status: StageStatus): string {
  if (status === 'active') return theme.ink;
  if (status === 'done') return theme.inkSoft;
  if (status === 'err') return theme.danger;
  return theme.muted;
}

function durationOf(stage: StageView, now: number): string {
  if (stage.status === 'done' && stage.startedAt && stage.endedAt) {
    return formatMs(stage.endedAt - stage.startedAt);
  }
  if (stage.status === 'active' && stage.startedAt) {
    return formatMs(now - stage.startedAt);
  }
  return '';
}

/**
 * One node on the horizontal pipeline rail: a leading connector (rendered for
 * every node but the first) plus the stage glyph and short name. The connector
 * is what turns a row of格子 into a left-to-right flow. Per-stage durations are
 * deliberately omitted here — they only cluttered the rail; the overall elapsed
 * lives in the header and the active stage's own duration in the detail line.
 */
const StageNode = React.memo(function StageNode({
  stage, tick, first, compact,
}: {
  stage: StageView;
  tick: number;
  first: boolean;
  compact: boolean;
}) {
  return (
    <Box flexDirection="row">
      {first ? null : <Text color={theme.line}>{compact ? ' · ' : ' ── '}</Text>}
      <Text color={stageColor(stage.status)}>{glyph(stage.status, tick)} </Text>
      <Text color={labelColor(stage.status)} bold={stage.status === 'active'}>{stage.name}</Text>
    </Box>
  );
});

export const PipelinePanel = React.memo(function PipelinePanel({ phases }: {
  phases: PipelinePhase[] | null;
}) {
  const [tick, setTick] = useState(0);
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 80;
  const compact = termWidth < 72;

  const hasActive = phases?.some(p => p.status === 'active') ?? false;

  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => setTick(t => t + 1), SPINNER_FRAME_MS);
    return () => clearInterval(timer);
  }, [hasActive]);

  if (!phases || phases.length === 0) return <Box />;

  const now = Date.now();
  const seen = new Map(phases.map(p => [p.phase, p]));

  // Overlay the seen phases onto the canonical ordered stage list so pending
  // stages still appear. Internal phase codes never reach the screen.
  const stages: StageView[] = STAGE_ORDER.map((code) => {
    const p = seen.get(code);
    const display = stageDisplay(code);
    return {
      code,
      name: display.name,
      description: display.description,
      status: p?.status ?? 'pending',
      ...(p?.startedAt !== undefined && { startedAt: p.startedAt }),
      ...(p?.endedAt !== undefined && { endedAt: p.endedAt }),
      ...(p?.detail !== undefined && { detail: p.detail }),
    };
  });

  const doneCount = stages.filter(s => s.status === 'done').length;
  const active = stages.find(s => s.status === 'active');
  const allDone = doneCount === stages.length;

  // Overall elapsed: earliest stage start → latest end (or now while running).
  const startTimes = stages.filter(s => s.startedAt).map(s => s.startedAt!);
  const endTimes = stages.filter(s => s.endedAt).map(s => s.endedAt!);
  const overallStart = startTimes.length ? Math.min(...startTimes) : undefined;
  const overallEnd = allDone && endTimes.length ? Math.max(...endTimes) : now;
  const totalDur = overallStart ? formatMs(overallEnd - overallStart) : '';

  const progress = allDone
    ? '✓ done'
    : `${doneCount}/${stages.length}${totalDur ? ` · ${totalDur}` : ''}`;
  const activeDur = active ? durationOf(active, now) : '';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.line} paddingX={1}>
      {/* header — label left, overall progress right */}
      <Box justifyContent="space-between">
        <Box>
          <Text color={theme.muted}>PIPELINE · </Text>
          <Text color={theme.accent2} bold>orchestrator</Text>
        </Box>
        <Text color={allDone ? theme.plus : theme.muted}>{progress}</Text>
      </Box>

      {/* rail — connected stage flow */}
      <Box flexDirection="row" flexWrap="wrap">
        {stages.map((s, i) => (
          <StageNode key={s.code} stage={s} tick={tick} first={i === 0} compact={compact} />
        ))}
      </Box>

      {/* active stage detail — glyph + name + description + its own duration */}
      {active ? (
        <Box flexDirection="row">
          <Text color={theme.accent}>{glyph(active.status, tick)} </Text>
          <Text color={theme.accent} bold>{active.name}</Text>
          {active.description ? <Text color={theme.muted}> · {active.description}</Text> : null}
          {activeDur ? <Text color={theme.muted}> · {activeDur}</Text> : null}
        </Box>
      ) : (
        <Text color={theme.muted}>{allDone ? 'Pipeline complete' : 'Pipeline idle'}</Text>
      )}
    </Box>
  );
});
