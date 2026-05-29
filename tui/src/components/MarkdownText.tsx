import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { parseMarkdown, type MarkdownInline } from '../markdown.js';
import { theme } from '../theme.js';

function InlineMarkdown({ segments, soft }: { segments: MarkdownInline[]; soft?: boolean }) {
  return (
    <Text>
      {segments.map((segment, index) => {
        if (segment.kind === 'code') {
          return (
            <Text key={index} color={theme.accent2} backgroundColor={theme.bg}>
              {segment.text}
            </Text>
          );
        }
        if (segment.kind === 'strong') {
          return <Text key={index} color={theme.ink} bold>{segment.text}</Text>;
        }
        if (segment.kind === 'emphasis') {
          return <Text key={index} color={theme.inkSoft} italic>{segment.text}</Text>;
        }
        return <Text key={index} color={soft ? theme.inkSoft : theme.ink}>{segment.text}</Text>;
      })}
    </Text>
  );
}

export const MarkdownText = React.memo(function MarkdownText({ text, soft = false }: {
  text: string;
  soft?: boolean;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);

  if (blocks.length === 0) return null;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const prefix = block.level <= 2 ? '▌ ' : '· ';
          return (
            <Box key={index} marginTop={index === 0 ? 0 : 1}>
              <Text color={theme.accent} bold>{prefix}</Text>
              <InlineMarkdown segments={block.children} />
            </Box>
          );
        }

        if (block.type === 'list_item') {
          return (
            <Box key={index} paddingLeft={block.depth * 2}>
              <Text color={theme.accent}>{block.marker} </Text>
              <InlineMarkdown segments={block.children} soft={soft} />
            </Box>
          );
        }

        if (block.type === 'quote') {
          return (
            <Box key={index} paddingLeft={1}>
              <Text color={theme.muted}>│ </Text>
              <InlineMarkdown segments={block.children} soft />
            </Box>
          );
        }

        if (block.type === 'code') {
          return (
            <Box
              key={index}
              flexDirection="column"
              borderStyle="single"
              borderColor={theme.line}
              paddingX={1}
              marginY={1}
            >
              {block.language ? <Text color={theme.muted}>{block.language}</Text> : null}
              {block.lines.length ? block.lines.map((line, lineIndex) => (
                <Text key={lineIndex} color={theme.inkSoft}>{line || ' '}</Text>
              )) : <Text color={theme.inkSoft}> </Text>}
            </Box>
          );
        }

        return (
          <Box key={index}>
            <InlineMarkdown segments={block.children} soft={soft} />
          </Box>
        );
      })}
    </Box>
  );
});
