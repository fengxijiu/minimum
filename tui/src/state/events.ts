import type { ApprovalMode, Mode, PlanStep, EditMode } from '../types.js';

/**
 * AgentEvent — every state mutation flows through a typed event.
 * Inspired by DeepSeek-Reasonix's AgentEvent pattern.
 */
export type AgentEvent =
  // conversation
  | { type: 'user.submit'; text: string }
  | { type: 'assistant.chunk'; text: string }
  | { type: 'assistant.final'; text: string }
  | { type: 'tool.start'; id: string; name: string; args: string }
  | { type: 'tool.output'; id: string; text: string }
  | { type: 'tool.end'; id: string; ok: boolean; meta?: string }
  | { type: 'system.push'; text: string; tone?: 'info' | 'warn' | 'ok' }
  | { type: 'error.push'; title: string; lines: string[] }
  | { type: 'diff.push'; file: string; added: number; removed: number; lines: string[] }
  | { type: 'chips.push'; chips: import('../types.js').Chip[] }
  | { type: 'permission.show'; perm: import('../types.js').Permission }
  // session
  | { type: 'session.clear' }
  | { type: 'session.reset' }
  | { type: 'messages.clear' }
  | { type: 'messages.commit' }
  | { type: 'session.load'; name: string }
  // UI state
  | { type: 'input.change'; value: string }
  | { type: 'input.submit' }
  | { type: 'approval.change'; mode: ApprovalMode }
  | { type: 'mode.change'; mode: Mode }
  | { type: 'ctx.update'; used: number; max?: number }
  // plan
  | { type: 'plan.set'; title: string; steps: PlanStep[] }
  | { type: 'plan.step.update'; index: number; status: PlanStep['status'] }
  // files / edits
  | { type: 'files.set'; files: import('../types.js').FileEntry[] }
  | { type: 'edit.add'; edit: import('../types.js').StagedEdit }
  | { type: 'edit.remove'; index: number }
  | { type: 'edits.clear' }
  // pending / overlay
  | { type: 'pending.set'; value: import('../types.js').PendingState }
  | { type: 'pending.clear' }
  | { type: 'help.toggle' }
  // turn lifecycle
  | { type: 'turn.start' }
  | { type: 'turn.end'; success: boolean }
  // toast notifications
  | { type: 'toast.show'; text: string; tone: 'info' | 'warn' | 'ok' | 'err'; ttlMs?: number }
  | { type: 'toast.dismiss'; id: string }
  // usage / cost tracking
  | { type: 'usage.update'; promptTokens?: number; completionTokens?: number; cost?: number }
  // edit mode
  | { type: 'edit.mode.change'; mode: EditMode }
  | { type: 'edit.undo' }
  // mcp
  | { type: 'mcp.loading'; ready: number; total: number }
  // verbose
  | { type: 'verbose.toggle' }
  // pipeline (orchestrator)
  | { type: 'pipeline.start' }
  | { type: 'pipeline.phase'; phase: string; label: string; detail?: string }
  | { type: 'pipeline.end' }
  // init
  | { type: 'init.run'; cwd: string; args?: string[] };
