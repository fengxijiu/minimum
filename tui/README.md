# minimum

Interactive coding CLI built on the MiMo model. Ink + TypeScript.

## Run

```bash
npm install            # or pnpm / yarn
npm run dev            # tsx src/cli.tsx
```

Build & run from compiled output:

```bash
npm run build
npm start
```

Install globally (after `npm run build`):

```bash
npm link
minimum
```

## Keys

| key             | does                          |
| --------------- | ----------------------------- |
| <kbd>tab</kbd>  | toggle `agent` ↔ `chat` mode  |
| <kbd>esc</kbd>  | quit                          |
| typing + ↵      | append to chat (mocked reply) |

## Layout

The TUI is a 02+04 hybrid wireframe direction:

- **plan strip** across the top — current task broken into steps
- **context rail** on the left — what mimo "sees" right now
- **chat stream** as the body — user / model / tool calls / inline diffs
- **status bar** at the bottom — mode pill, model, token meter, key hints

Palette (`src/theme.ts`) — cyan phosphor on midnight, mostly `chalk`-safe:

| token       | hex       | usage                            |
| ----------- | --------- | -------------------------------- |
| `accent`    | `#4dd0ff` | cursor, staged file, current step|
| `accent2`   | `#b56cff` | secondary highlights             |
| `plus`      | `#6ee37a` | diff +                           |
| `minus`     | `#ff7d8c` | diff −                           |
| `warn`      | `#ffce4d` | tool-permission prompts          |
| `danger`    | `#ff5c6b` | errors / interrupts              |

## Source map

```
src/
├── cli.tsx              entry · render(<App/>)
├── app.tsx              layout + global state + input handling
├── theme.ts             palette
├── types.ts             AppState, Message, ToolCall, Diff, …
├── mock.ts              seed state (replace with real agent stream)
└── components/
    ├── TitleBar.tsx
    ├── PlanStrip.tsx
    ├── ContextRail.tsx
    ├── ChatStream.tsx
    ├── Prompt.tsx
    ├── StatusBar.tsx
    └── atoms.tsx        ToolLine · DiffBlock · ChipsRow · TokenMeter
```

## Wiring the model

The conversation in `mock.ts` is static — there is no real agent yet. To
plug MiMo in, replace `handleSubmit` in `src/app.tsx`:

```ts
const handleSubmit = async (text: string) => {
  appendUser(text);
  for await (const chunk of streamFromMimo(text, state.messages)) {
    appendChunk(chunk);
  }
};
```

`streamFromMimo` should yield `Message` objects: assistant text deltas,
tool calls, diffs, chips. The renderer is already shaped for that.

## Terminal notes

- Needs a Unicode + truecolor terminal (iTerm2, Alacritty, Kitty,
  WezTerm, modern Windows Terminal). Older terminals will fall back to
  256-color and the glyphs `● ○ ◆ ◇ ›` will still render.
- Set your terminal background dark for the palette to feel right; the
  TUI uses transparent backgrounds so the terminal's own dark shows
  through.
