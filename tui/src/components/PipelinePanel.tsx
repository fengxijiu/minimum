import React, { useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from '../theme.js';
import type { PipelinePhase } from '../types.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAME_MS = 250;

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

function PhaseBox({
  phase, tick, compact, now,
}: {
  phase: PipelinePhase;
  tick: number;
  compact: boolean;
  now: number;
}) {
  const isActive  = phase.status === 'active';
  const isDone    = phase.status === 'done';
  const isErr     = phase.status === 'err';
  const isPending = phase.status === 'pending';

  // Sigil
  const sigil = isDone
    ? '✓'
    : isErr
    ? '✗'
    : isActive
    ? SPINNER[tick % SPINNER.length]!
    : '○';

  // Timing
  let durationStr = '';
  if (isDone && phase.startedAt && phase.endedAt) {
    durationStr = formatMs(phase.endedAt - phase.startedAt);
  } else if (isActive && phase.startedAt) {
    durationStr = formatMs(now - phase.startedAt);
  }

  const borderColor = isActive ? theme.accent : isErr ? theme.danger : isDone ? theme.line : theme.line;
  const phaseColor  = isActive ? theme.accent : isErr ? theme.danger : isDone ? theme.plus : theme.muted;
  const labelColor  = isActive ? theme.ink    : isDone ? theme.inkSoft : theme.muted;

  return (
    <Box
      key={phase.phase}
      flexDirection="column"
      marginRight={1}
      borderStyle="round"
      borderColor={borderColor}
      paddingX={compact ? 0 : 1}
    >
      {/* header row: phase id + sigil */}
      <Box flexDirection="row">
        <Text color={phaseColor} bold={isActive}>{phase.phase} </Text>
        <Text color={phaseColor}>{sigil}</Text>
        {durationStr ? <Text color={theme.muted}>  {durationStr}</Text> : null}
      </Box>

      {/* label + optional detail */}
      {!compact && (
        <Text color={labelColor} bold={isActive}>{phase.label}</Text>
      )}
      {!compact && phase.detail && (
        <Text color={theme.muted}>{phase.detail}</Text>
      )}
    </Box>
  );
}

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
  const doneCount   = phases.filter(p => p.status === 'done').length;
  const activePhase = phases.find(p => p.status === 'active');
  const allDone     = doneCount === phases.length;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* ── header ── */}
      <Box justifyContent="space-between">
        <Box>
          <Text color={theme.muted}>PIPELINE · </Text>
          <Text color={theme.accent2} bold>orchestrator</Text>
          {activePhase && !compact && (
            <Text color={theme.muted}> · {activePhase.label}</Text>
          )}
        </Box>
        <Text color={allDone ? theme.plus : theme.muted}>
          {allDone ? '✓ done' : `${doneCount}/${phases.length}`}
        </Text>
      </Box>

      {/* ── phase boxes ── */}
      <Box flexDirection="row" marginTop={0}>
        {phases.map((p, i) => (
          <PhaseBox
            key={`${p.phase}-${i}`}
            phase={p}
            tick={tick}
            compact={compact}
            now={now}
          />
        ))}
      </Box>
    </Box>
  );
});
