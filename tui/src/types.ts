export type Mode = 'chat' | 'agent';

export type ToolKind = 'read' | 'edit' | 'run' | 'find';
export type ToolCall = {
  kind: ToolKind;
  args: string;
  meta?: string;
  status?: 'ok' | 'err';
};

export type Diff = {
  file: string;
  added: number;
  removed: number;
  lines: string[]; // each starts with '+', '-', or ' '
  collapsed?: boolean;
};

export type Chip = { key: string; label: string; primary?: boolean };

export type Message =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'assistant'; text: string }
  | { id: string; type: 'system'; text: string; tone?: 'info' | 'warn' | 'ok' }
  | { id: string; type: 'tool'; tool: ToolCall }
  | { id: string; type: 'diff'; diff: Diff }
  | { id: string; type: 'chips'; chips: Chip[] };

export type PlanStep = {
  label: string;
  status: 'done' | 'now' | 'next';
};

export type FileEntry = { name: string; meta: string; staged?: boolean };
export type StagedEdit = { sign: '+' | '~' | '-'; label: string };

export type AppState = {
  path: string;
  branch: string;
  mode: Mode;
  ctx: { used: number; max: number };
  files: FileEntry[];
  edits: StagedEdit[];
  plan: { title: string; steps: PlanStep[] };
  currentStepLabel: string;
  messages: Message[];
  input: string;
};
