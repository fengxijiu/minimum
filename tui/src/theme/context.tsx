import React, { createContext, useContext, useState, useCallback } from 'react';

export type ThemeName = 'midnight' | 'light' | 'dracula';

export interface ThemeTokens {
  bg: string;
  paper: string;
  paper2: string;
  paper3: string;
  ink: string;
  inkSoft: string;
  muted: string;
  line: string;
  highlight: string;
  accent: string;
  accent2: string;
  plus: string;
  minus: string;
  danger: string;
  warn: string;
}

const themes: Record<ThemeName, ThemeTokens> = {
  midnight: {
    bg: '#07090f', paper: '#0e1320', paper2: '#161d2d', paper3: '#1d2638',
    ink: '#d6e0f0', inkSoft: '#9aa6bf', muted: '#5b6a87', line: '#34405a',
    highlight: '#15314a', accent: '#4dd0ff', accent2: '#b56cff',
    plus: '#6ee37a', minus: '#ff7d8c', danger: '#ff5c6b', warn: '#ffce4d',
  },
  light: {
    bg: '#ffffff', paper: '#f5f5f5', paper2: '#e8e8e8', paper3: '#d0d0d0',
    ink: '#1a1a1a', inkSoft: '#555555', muted: '#999999', line: '#cccccc',
    highlight: '#e0f0ff', accent: '#0066cc', accent2: '#9933ff',
    plus: '#228822', minus: '#cc2222', danger: '#dd0000', warn: '#cc8800',
  },
  dracula: {
    bg: '#282a36', paper: '#343746', paper2: '#3c3f58', paper3: '#44475a',
    ink: '#f8f8f2', inkSoft: '#bfbfbf', muted: '#6272a4', line: '#44475a',
    highlight: '#44475a', accent: '#50fa7b', accent2: '#ff79c6',
    plus: '#50fa7b', minus: '#ff5555', danger: '#ff5555', warn: '#f1fa8c',
  },
};

interface ThemeContextValue {
  name: ThemeName;
  theme: ThemeTokens;
  setTheme: (name: ThemeName) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  name: 'midnight',
  theme: themes.midnight,
  setTheme: () => {},
});

export function ThemeProvider({ children, initial }: {
  children: React.ReactNode;
  initial?: ThemeName;
}) {
  const [name, setName] = useState<ThemeName>(initial ?? 'midnight');
  const setTheme = useCallback((n: ThemeName) => setName(n), []);
  return (
    <ThemeContext.Provider value={{ name, theme: themes[name], setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export { themes };
