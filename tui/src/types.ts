export type Mode = 'chat' | 'agent' | 'orchestrate';

export type ToolKind = 'read' | 'edit' | 'run' | 'find';
export type ToolCall = {
  kind: ToolKind;
  args: string;
  meta?: string;
  status?: 'ok' | 'err';
  /** Captured result output lines (success or failure). Shown folded; expanded in verbose. */
  output?: string[];
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
  /** Full per-parameter breakdown of what's being approved. */
  details?: string[];
  risk?: 'low' | 'medium' | 'high';
};

export type ErrorReport = {
  title: string;       // e.g. 'STDERR · 1 FAILURE'
  lines: string[];
  /** What was being attempted when this failed, e.g. 'run · pytest -q'. */
  context?: string;
  /** Truthful, always-available next-step hint shown in the footer. */
  hint?: string;
};

export type Message =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'assistant'; text: string }
  | { id: string; type: 'system'; text: string; tone?: 'info' | 'warn' | 'ok' }
  | { id: string; type: 'tool'; tool: ToolCall }
  | { id: string; type: 'diff'; diff: Diff }
  | { id: string; type: 'chips'; chips: Chip[] }
  | { id: string; type: 'permission'; perm: Permission }
  | { id: string; type: 'error'; error: ErrorReport }
  /** End-of-turn summary line: "7 tools · 1.2k tok · $0.03". Rendered as an informative divider. */
  | { id: string; type: 'turnmeta'; summary: string };

export type SessionState = 'agent' | 'mimo' | 'orchestrate' | 'paused' | 'error';

export type ApprovalMode = 'read-only' | 'auto-edit' | 'full-auto';

export type PlanStep = {
  label: string;
  status: 'done' | 'now' | 'next';
};

export type FileEntry = { name: string; meta: string; staged?: boolean };
export type StagedEdit = { sign: '+' | '~' | '-'; label: string };

export type PendingState = null | 'permission' | 'error' | 'choice';

export type ChoiceOption = { id: string; title: string; summary?: string };
export type ChoiceRequest = {
  question: string;
  options: ChoiceOption[];
  allowCustom: boolean;
};

/** One W0–W4 phase in the orchestrator pipeline panel, including W3.5. */
export type PipelinePhase = {
  phase: string;     // 'W0' | 'W1' | 'W0.5' | 'W2/3' | 'W3.5' | 'W4'
  label: string;
  status: 'pending' | 'active' | 'done' | 'err';
  startedAt?: number;
  endedAt?: number;
  detail?: string;
};

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
  ctx: { used: number; max: number };
  files: FileEntry[];
  edits: StagedEdit[];
  /** LIFO redo stack — populated by /undo, drained by /redo, cleared on any new edit. */
  redo: StagedEdit[];
  plan: { title: string; steps: PlanStep[] };
  currentStepLabel: string;
  messages: Message[];
  /**
   * How many messages from the start of `messages[]` have been committed to the
   * Static scrollback layer.  Messages in [0, committedCount) are rendered once
   * via <Static> and never re-drawn; messages in [committedCount, …) are the
   * live tail rendered in the active frame.
   */
  committedCount: number;
  input: string;
  pending: PendingState;
  helpOpen: boolean;
  turnInProgress: boolean;
  verbose: boolean;
  /** Streaming text accumulator — non-null while assistant is generating. */
  streaming: string | null;
  /** Live reasoning/thinking accumulator — non-null while the model is thinking. Cleared at turn end. */
  reasoning: string | null;
  /** Currently executing tool — shown in the live activity area. */
  activeTool: ToolProgress | null;
  /** Whether the idle mascot is visible in the live chat tail. */
  petVisible: boolean;
  /** Toast notifications with auto-dismiss. */
  toasts: Toast[];
  /** Token and cost tracking. */
  usage: UsageInfo;
  /** MCP loading progress — null when no MCP servers are loading. */
  mcpLoading: { ready: number; total: number } | null;
  /** Active session name — null for ephemeral sessions. */
  sessionName: string | null;
  /** Plan mode — when true the engine blocks all mutating tools so the AI only plans. */
  planMode: boolean;
  /** Orchestrator pipeline phases — null when not running the pipeline. */
  pipeline: PipelinePhase[] | null;
};
