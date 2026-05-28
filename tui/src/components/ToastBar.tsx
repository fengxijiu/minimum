import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { Toast } from '../types.js';

const TONE_COLOR: Record<Toast['tone'], string> = {
  info: theme.accent,
  warn: theme.warn,
  ok: theme.plus,
  err: theme.danger,
};

export function ToastBar({ toasts, onDismiss }: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  // Auto-dismiss expired toasts.
  useEffect(() => {
    if (!toasts.length) return;
    const now = Date.now();
    const nextExpiry = toasts.reduce((min, t) => Math.min(min, t.ttlMs - (now - t.bornAt)), Infinity);
    if (nextExpiry <= 0) {
      for (const t of toasts) onDismiss(t.id);
      return;
    }
    const timer = setTimeout(() => {
      for (const t of toasts) onDismiss(t.id);
    }, nextExpiry);
    return () => clearTimeout(timer);
  }, [toasts, onDismiss]);

  if (!toasts.length) return <Box />;

  return (
    <Box flexDirection="column">
      {toasts.map(t => (
        <Box key={t.id} paddingLeft={3}>
          <Text color={TONE_COLOR[t.tone]}>· </Text>
          <Text color={theme.inkSoft}>{t.text}</Text>
        </Box>
      ))}
    </Box>
  );
}
