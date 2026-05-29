import { execSync } from 'node:child_process';
import type { AppState } from './types.js';

function detectBranch(cwd: string): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return 'main';
  }
}

/** Create a fresh AppState for the given working directory. */
export function createInitialState(cwd: string): AppState {
  return {
    path: cwd,
    branch: detectBranch(cwd),
    mode: 'agent',
    approvalMode: 'auto-edit',
    editMode: 'review',
    ctx: { used: 0, max: 200 },
    files: [],
    edits: [],
    redo: [],
    plan: { title: '', steps: [] },
    currentStepLabel: '',
    messages: [],
    committedCount: 0,
    input: '',
    pending: null,
    helpOpen: false,
    turnInProgress: false,
    verbose: false,
    streaming: null,
    activeTool: null,
    toasts: [],
    usage: { promptTokens: 0, completionTokens: 0, sessionCost: 0, lastTurnCost: 0, cacheHit: 0 },
    mcpLoading: null,
    sessionName: null,
    pipeline: null,
  };
}
