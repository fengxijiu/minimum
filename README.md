# Minimum

Minimum is a TypeScript/Ink terminal UI for experimenting with MiMo-style coding agent loops.

The current TUI is intentionally smaller than full agent clients such as CodeWhale or Reasonix, but it now uses a cleaner architecture:

- A `TuiController` owns the MiMo loop lifecycle.
- Loop events are normalized into TUI events before rendering.
- The Ink app renders cards and handles input, commands, queueing, cancellation, and sessions.
- Saved transcripts live under `.minimum/sessions`.

## Features

- Ink-based interactive terminal UI.
- Streaming assistant card updates.
- Tool call and tool result cards.
- Busy-state task queue.
- Turn cancellation with `Esc` or `/cancel`.
- Mid-turn steering with `/steer`.
- File mentions with `@path`.
- Command and file completion with `Tab`.
- Repeating prompt loop with `/loop`.
- Session save/load as JSON transcripts.
- Mock mode when `MIMO_API_KEY` is not set.

## Requirements

- Node.js 22 or newer.
- npm.

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Run

```bash
npm run build
node bin/minimum-ink.js
```

The default `minimum` binary also points to the Ink TUI:

```bash
npx minimum
```

## MiMo API

Without credentials, Minimum runs in local mock mode.

To use the real MiMo API, set:

```bash
set MIMO_API_KEY=your_key_here
```

Optional:

```bash
set MIMO_BASE_URL=https://api.xiaomimimo.com/v1
```

Shell execution is disabled by default. To expose the shell tool to the model:

```bash
set MINIMUM_ENABLE_SHELL=1
```

## TUI Commands

```text
/help          Show commands
/new           Start a fresh session
/save [name]   Save transcript to .minimum/sessions
/load [name]   Load transcript
/sessions      List saved sessions
/status        Show runtime status
/queue         Show queued tasks
/queue clear   Clear queued tasks
/steer <text>  Inject guidance into the current turn
/cancel        Cancel the current turn
/loop 30s task Run a prompt repeatedly
/loop stop     Stop the active loop
/clear         Clear visible transcript
/exit          Exit
```

## Repository Notes

The two comparison archives are intentionally excluded from git:

- `CodeWhale-main.zip`
- `DeepSeek-Reasonix-main.zip`

Generated and local-only paths such as `node_modules`, `dist`, and `.minimum` are also ignored.
