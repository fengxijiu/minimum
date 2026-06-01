import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

const IDLE_BITMAP = [
  '000011000110000',
  '000101000101000',
  '001000101000100',
  '001000111000100',
  '001101111101100',
  '011100000001110',
  '000001000100000',
  '011011101110110',
  '000001000100000',
  '011111111111110',
  '001111111111100',
  '000100000001000',
];

function renderBitmap(cols: number): string[] {
  if (cols < 20) return [];
  const lines = IDLE_BITMAP.map(line => line.padEnd(16, '0').slice(0, 16));
  const rows: string[] = [];
  for (let y = 0; y < lines.length; y += 2) {
    let out = '';
    const upperLine = lines[y] ?? ''.padEnd(16, '0');
    const lowerLine = lines[y + 1] ?? ''.padEnd(16, '0');
    for (let x = 0; x < 16; x++) {
      const upper = upperLine[x] === '1';
      const lower = lowerLine[x] === '1';
      out += upper && lower ? '█' : upper ? '▀' : lower ? '▄' : ' ';
    }
    rows.push(out.replace(/\s+$/, ''));
  }
  return rows;
}

export const LiliMimoIdle = React.memo(function LiliMimoIdle({ cols }: { cols: number }) {
  const lines = useMemo(() => renderBitmap(cols), [cols]);
  if (lines.length === 0) return null;

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2}>
      {lines.map((line, i) => (
        <Text key={i} color={theme.accent2}>{line}</Text>
      ))}
    </Box>
  );
});
