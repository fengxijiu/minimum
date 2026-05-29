export type MarkdownInlineKind = 'text' | 'strong' | 'emphasis' | 'code';

export type MarkdownInline = {
  kind: MarkdownInlineKind;
  text: string;
};

export type MarkdownBlock =
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'heading'; level: number; children: MarkdownInline[] }
  | { type: 'list_item'; ordered: boolean; depth: number; marker: string; children: MarkdownInline[] }
  | { type: 'quote'; children: MarkdownInline[] }
  | { type: 'code'; language?: string; lines: string[] };

function pushText(target: MarkdownInline[], kind: MarkdownInlineKind, text: string): void {
  if (!text) return;
  const last = target[target.length - 1];
  if (last?.kind === kind) {
    last.text += text;
    return;
  }
  target.push({ kind, text });
}

function findClosing(input: string, marker: string, from: number): number {
  const idx = input.indexOf(marker, from);
  return idx >= 0 ? idx : -1;
}

export function parseInlineMarkdown(input: string): MarkdownInline[] {
  const segments: MarkdownInline[] = [];
  let i = 0;

  while (i < input.length) {
    const rest = input.slice(i);

    if (rest.startsWith('`')) {
      const end = findClosing(input, '`', i + 1);
      if (end > i + 1) {
        pushText(segments, 'code', input.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }

    const strongMarker = rest.startsWith('**') ? '**' : rest.startsWith('__') ? '__' : null;
    if (strongMarker) {
      const end = findClosing(input, strongMarker, i + strongMarker.length);
      if (end > i + strongMarker.length) {
        pushText(segments, 'strong', input.slice(i + strongMarker.length, end));
        i = end + strongMarker.length;
        continue;
      }
    }

    const emphasisMarker = rest.startsWith('*') ? '*' : rest.startsWith('_') ? '_' : null;
    if (emphasisMarker) {
      const end = findClosing(input, emphasisMarker, i + 1);
      if (end > i + 1) {
        pushText(segments, 'emphasis', input.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }

    const nextSpecial = ['`', '*', '_']
      .map(marker => input.indexOf(marker, i + 1))
      .filter(idx => idx >= 0)
      .sort((a, b) => a - b)[0];
    const end = nextSpecial ?? input.length;
    pushText(segments, 'text', input.slice(i, end));
    i = end;
  }

  return segments;
}

function pushParagraph(blocks: MarkdownBlock[], paragraph: string[]): void {
  if (!paragraph.length) return;
  blocks.push({ type: 'paragraph', children: parseInlineMarkdown(paragraph.join(' ')) });
  paragraph.length = 0;
}

export function parseMarkdown(input: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const paragraph: string[] = [];
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  let codeLanguage: string | undefined;
  let codeLines: string[] = [];

  for (const line of lines) {
    const fence = line.match(/^```\s*([^`]*)\s*$/);
    if (fence) {
      if (codeLanguage !== undefined) {
        blocks.push({ type: 'code', language: codeLanguage || undefined, lines: codeLines });
        codeLanguage = undefined;
        codeLines = [];
      } else {
        pushParagraph(blocks, paragraph);
        codeLanguage = fence[1]?.trim() ?? '';
        codeLines = [];
      }
      continue;
    }

    if (codeLanguage !== undefined) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      pushParagraph(blocks, paragraph);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      pushParagraph(blocks, paragraph);
      blocks.push({
        type: 'heading',
        level: heading[1]!.length,
        children: parseInlineMarkdown(heading[2]!.trim()),
      });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      pushParagraph(blocks, paragraph);
      blocks.push({ type: 'quote', children: parseInlineMarkdown(quote[1] ?? '') });
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) {
      pushParagraph(blocks, paragraph);
      blocks.push({
        type: 'list_item',
        ordered: false,
        depth: Math.floor((bullet[1]?.length ?? 0) / 2),
        marker: '•',
        children: parseInlineMarkdown(bullet[2]!.trim()),
      });
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      pushParagraph(blocks, paragraph);
      blocks.push({
        type: 'list_item',
        ordered: true,
        depth: Math.floor((ordered[1]?.length ?? 0) / 2),
        marker: `${ordered[2]}.`,
        children: parseInlineMarkdown(ordered[3]!.trim()),
      });
      continue;
    }

    paragraph.push(line.trim());
  }

  if (codeLanguage !== undefined) {
    blocks.push({ type: 'code', language: codeLanguage || undefined, lines: codeLines });
  }
  pushParagraph(blocks, paragraph);

  return blocks;
}
