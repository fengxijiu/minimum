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

/** One short-name cell in the horizontal stage overview — no internal phase code. */
const StageCell = React.memo(function StageCell({
  stage, tick, now, showDuration,
}: {
  stage: StageView;
  tick: number;
  now: number;
  showDuration: boolean;
}) {
  const dur = showDuration ? durationOf(stage, now) : '';
  return (
    <Box flexDirection="row" marginRight={2}>
      <Text color={stageColor(stage.status)}>{glyph(stage.status, tick)} </Text>
      <Text color={labelColor(stage.status)} bold={stage.status === 'active'}>{stage.name}</Text>
      {dur ? <Text color={theme.muted}> {dur}</Text> : null}
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

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* line 1 — header */}
      <Box justifyContent="space-between">
        <Box>
          <Text color={theme.muted}>PIPELINE · </Text>
          <Text color={theme.accent2} bold>orchestrator</Text>
        </Box>
        <Text color={allDone ? theme.plus : theme.muted}>
          {allDone ? '✓ done' : `${doneCount}/${stages.length}`}
        </Text>
      </Box>

      {/* line 2 — horizontal short-name overview */}
      <Box flexDirection="row" flexWrap="wrap">
        {stages.map((s) => (
          <StageCell key={s.code} stage={s} tick={tick} now={now} showDuration={!compact} />
        ))}
      </Box>

      {/* line 3 — current stage detail */}
      {active ? (
        <Box flexDirection="row">
          <Text color={theme.muted}>Now: </Text>
          <Text color={theme.accent} bold>{active.name}</Text>
          {durationOf(active, now) ? <Text color={theme.muted}> · {durationOf(active, now)}</Text> : null}
          {active.description ? <Text color={theme.muted}> · {active.description}</Text> : null}
        </Box>
      ) : (
        <Text color={theme.muted}>{allDone ? 'Pipeline complete' : 'Pipeline idle'}</Text>
      )}
    </Box>
  );
});
