// Color tokens for the minimum TUI.
// Mirrors the wireframe palette: cyan phosphor on midnight.

export const theme = {
  bg:        '#07090f',
  paper:     '#0e1320',
  paper2:    '#161d2d',
  paper3:    '#1d2638',
  ink:       '#d6e0f0',
  inkSoft:   '#9aa6bf',
  muted:     '#5b6a87',
  line:      '#34405a',
  highlight: '#15314a',
  accent:    '#4dd0ff', // cyan — cursor / primary
  accent2:   '#b56cff', // magenta — secondary
  plus:      '#6ee37a', // diff +
  minus:     '#ff7d8c', // diff −
  danger:    '#ff5c6b',
  warn:      '#ffce4d',
} as const;

export type ThemeKey = keyof typeof theme;
