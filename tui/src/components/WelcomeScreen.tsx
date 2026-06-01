import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { EngineInfo } from '../engine.js';

const LOGO_LINES = [
  ' ███╗     ██╗   ███╗   ████╗   ██╗   ███╗   ████╗    ██╗   ███╗   ██╗   ████╗   ███╗',
  ' █████╗ ████║   ███║   █████╗  ██║   ███║   █████╗  ███║   ███║   ██║   █████╗ ████║',
  ' ███╔████╔██║   ███║   ███╔██╗ ██║   ███║   ███╔████╔██║   ███║   ██║   ███╔████╔██║',
  ' ███║╚██╔╝██║   ███║   ███║╚██╗██║   ███║   ███║╚██╔╝██║   ███║   ██║   ███║╚██╔╝██║',
  ' ███║ ╚═╝ ██║   ███║   ███║ ╚████║   ███║   ███║ ╚═╝ ██║    ╚██████╔╝   ███║ ╚═╝ ██║'
];
const POPPY_LINES = [
  '                   ██████                ██████                   ',
  '                ██████████              ██████████                ',
  '               █████    ████          ████    █████               ',
  '              ████        ████      ████        ████              ',
  '              ████        ████      ████        ████              ',
  '              ████        ████      ████        ████              ',
  '              ████        ████      ████        ████              ',
  '             █████        █████    █████        █████             ',
  '            ████████    ██████████████████    ████████            ',
  '        ████████████████████    ███    ███████████████████        ',
  '      ████████████████████   ██  █  ██   ███████████████████      ',
  '      ██████  ███████████   ████   ████   ███████████  ██████     ',
  '      ██████        ███████████████████████████        ██████     ',
  '    ██████████████████████████████████████████████████████████    ',
  '  ████████████████    ██████████████████████    ████████████████  ',
  '  ████   █████            ██████████████            ██████   ███  ',
  '  █████ ██████████    ██████████████████████    ███████████ ████  ',
  '    ██████████████████████████████████████████████████████████    ',
  '      ████  ████████████████          ████████████████  ████      ',
  '      ████  ████████  ██████████████████████  ████████  ████      ',
  '      ████      ██    ██████████████████████    ██      ████      ',
  '         █████  ██████████████████████████████████  █████         ',
  '      ██████      ██████                  ██████      ██████      ',
  '        ██████████████                      ██████████████        ',
  '        ██          ██                      ██          ██        ',
];
const STARTUP_VERSION = 'v0.1';
const SLOGAN_LINES = [
  'ᴛʜᴇ ᴍɪɴɪᴍᴜᴍ ᴇғғᴏʀᴛ',
  'ғᴏʀ ᴍᴀxɪᴍᴜᴍ ᴘʀᴏᴅᴜᴄᴛɪᴠɪᴛʏ',
];
const WIDE_SLOGAN_LINES = [
  'ᴛʜᴇ  ᴍɪɴɪᴍᴜᴍ  ᴇғғᴏʀᴛ',
  'ғᴏʀ  ᴍᴀxɪᴍᴜᴍ  ᴘʀᴏᴅᴜᴄᴛɪᴠɪᴛʏ',
];
const PROMPT = 'Describe a task or type /help.';
const DEFAULT_COLUMNS = 120;
const MIN_CONTENT_WIDTH = 34;
const FRAME_MARGIN = 4;
const WIDE_COLUMN_GAP = '    ';
const COMPACT_LOGO = ['MINIMUM'];
const MIN_WIDE_RIGHT_WIDTH = Math.max(
  ...LOGO_LINES.map(line => line.length),
  ...WIDE_SLOGAN_LINES.map(line => line.length),
  'commands   /help  @files  enter send'.length,
  PROMPT.length,
);

function fitText(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

function makeLine(text: string, width: number, align: 'left' | 'center' = 'left'): string {
  const fitted = fitText(text, width);
  const left = align === 'center' ? Math.max(0, Math.floor((width - fitted.length) / 2)) : 0;
  return `│${`${' '.repeat(left)}${fitted}`.padEnd(width, ' ')}│`;
}

function makeCenteredLine(text: string, width: number): string {
  return makeLine(text, width, 'center');
}

function padColumn(text: string, width: number): string {
  return fitText(text, width).padEnd(width, ' ');
}

function makeInfoLines(path: string, engine?: EngineInfo): string[] {
  const runtime = engine?.mode === 'engine'
    ? `engine     ${engine.model ?? 'mimo'}`
    : `engine     mock${engine?.reason ? ` (${engine.reason})` : ''}`;
  const tools = engine?.tools?.length ? `tools      ${engine.tools.length} available` : 'tools      pending';
  const baseUrl = engine?.baseUrl ? `api        ${engine.baseUrl}` : 'api        local session';

  return [
    `workspace  ${path}`,
    `version    ${STARTUP_VERSION}`,
    runtime,
    tools,
    `status     ${engine?.mode === 'engine' ? 'ready' : 'fallback'}`,
    baseUrl,
    'layout     adaptive wide start',
    'commands   /help  @files  enter send',
    '',
    PROMPT,
  ];
}

function makeWideWelcomeLines(path: string, width: number, engine?: EngineInfo): string[] {
  const poppyWidth = Math.max(...POPPY_LINES.map(line => line.length));
  const rightLines = [
    ...LOGO_LINES,
    '',
    ...WIDE_SLOGAN_LINES,
    '',
    ...makeInfoLines(path, engine),
  ];
  const rightWidth = width - poppyWidth - WIDE_COLUMN_GAP.length;
  const topPad = 0;
  const rows = Array.from({ length: POPPY_LINES.length }, (_, i) => {
    const right = rightLines[i - topPad] ?? '';
    return makeLine(`${padColumn(POPPY_LINES[i] ?? '', poppyWidth)}${WIDE_COLUMN_GAP}${padColumn(right, rightWidth)}`, width);
  });

  return [
    `╭${'─'.repeat(width)}╮`,
    makeLine('', width),
    ...rows,
    makeLine('', width),
    `╰${'─'.repeat(width)}╯`,
  ];
}

function makeWelcomeLines(path: string, cols?: number, engine?: EngineInfo): string[] {
  const details = [
    ...SLOGAN_LINES,
    ...makeInfoLines(path, engine),
  ];
  const available = Math.max(MIN_CONTENT_WIDTH, (cols ?? process.stdout.columns ?? DEFAULT_COLUMNS) - FRAME_MARGIN);
  const naturalWidth = Math.max(...LOGO_LINES.map(line => line.length), ...details.map(line => line.length)) + 2;
  const wideWidth = Math.max(...POPPY_LINES.map(line => line.length))
    + WIDE_COLUMN_GAP.length
    + MIN_WIDE_RIGHT_WIDTH;
  const width = Math.max(MIN_CONTENT_WIDTH, available);
  if (width >= wideWidth) return makeWideWelcomeLines(path, width, engine);

  const logo = width >= naturalWidth ? LOGO_LINES : COMPACT_LOGO;
  const blank = makeLine('', width);

  return [
    `╭${'─'.repeat(width)}╮`,
    blank,
    ...logo.map(line => makeCenteredLine(line, width)),
    blank,
    blank,
    ...SLOGAN_LINES.map(line => makeCenteredLine(line, width)),
    blank,
    makeCenteredLine(`workspace  ${path}`, width),
    makeCenteredLine(`version    ${STARTUP_VERSION}`, width),
    blank,
    makeCenteredLine(PROMPT, width),
    blank,
    `╰${'─'.repeat(width)}╯`,
  ];
}

export const WelcomeScreen = React.memo(function WelcomeScreen({ path = '~', engine, cols }: { path?: string; engine?: EngineInfo; cols?: number }) {
  const lines = makeWelcomeLines(path, cols, engine);

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1} paddingBottom={2}>
      {lines.map((line, i) => (
        <Text key={i} color={theme.accent} bold wrap="truncate">{line}</Text>
      ))}
    </Box>
  );
});
