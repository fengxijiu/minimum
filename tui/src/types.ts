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

export type Permission = {
  tool: string;        // e.g. 'run shell'
  cmd: string;         // e.g. '$ pytest -q'
  cwd: string;
  note: string;
};

export type ErrorReport = {
  title: string;       // e.g. 'STDERR · 1 FAILURE'
  lines: string[];
};

export type Message =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'assistant'; text: string }
  | { id: string; type: 'system'; text: string; tone?: 'info' | 'warn' | 'ok' }
  | { id: string; type: 'tool'; tool: ToolCall }
  | { id: string; type: 'diff'; diff: Diff }
  | { id: string; type: 'chips'; chips: Chip[] }
  | { id: string; type: 'permission'; perm: Permission }
  | { id: string; type: 'error'; error: ErrorReport };

export type SessionState = 'agent' | 'mimo' | 'paused' | 'error';

export type ApprovalMode = 'read-only' | 'auto-edit' | 'full-auto';

export type PlanStep = {
  label: string;
  status: 'done' | 'now' | 'next';
};

export type FileEntry = { name: string; meta: string; staged?: boolean };
export type StagedEdit = { sign: '+' | '~' | '-'; label: string };

export type PendingState = null | 'permission' | 'error';

export type EditMode = 'review' | 'auto' | 'yolo';

export type ToolProgress = {
  id: string;
  name: string;
  args: string;
  startedAt: number;
  status: 'running' | 'ok' | 'err';
  meta?: string;
};

export type Toast = {
  id: string;
  text: string;
  tone: 'info' | 'warn' | 'ok' | 'err';
  bornAt: number;
  ttlMs: number;
};

export type UsageInfo = {
  promptTokens: number;
  completionTokens: number;
  sessionCost: number;
  lastTurnCost: number;
  cacheHit: number;
};

export type AppState = {
  path: string;
  branch: string;
  mode: Mode;
  approvalMode: ApprovalMode;
  editMode: EditMode;
  ctx: { used: number; max: number };
  files: FileEntry[];
  edits: StagedEdit[];
  plan: { title: string; steps: PlanStep[] };
  currentStepLabel: string;
  messages: Message[];
  input: string;
  pending: PendingState;
  helpOpen: boolean;
  turnInProgress: boolean;
  verbose: boolean;
  /** Streaming text accumulator — non-null while assistant is generating. */
  streaming: string | null;
  /** Currently executing tool — shown in the live activity area. */
  activeTool: ToolProgress | null;
  /** Toast notifications with auto-dismiss. */
  toasts: Toast[];
  /** Token and cost tracking. */
  usage: UsageInfo;
  /** MCP loading progress — null when no MCP servers are loading. */
  mcpLoading: { ready: number; total: number } | null;
  /** Active session name — null for ephemeral sessions. */
  sessionName: string | null;
};
