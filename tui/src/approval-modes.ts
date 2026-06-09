import type { ApprovalMode, Mode } from './types.js';

const PIPELINE_APPROVAL_MODES: ReadonlyArray<ApprovalMode> = [
  'read-only',
  'auto-edit',
  'full-auto',
  'aware',
];

const STANDARD_APPROVAL_MODES: ReadonlyArray<ApprovalMode> = [
  'read-only',
  'auto-edit',
  'full-auto',
];

export function getAvailableApprovalModes(mode: Mode): ReadonlyArray<ApprovalMode> {
  return mode === 'orchestrate' ? PIPELINE_APPROVAL_MODES : STANDARD_APPROVAL_MODES;
}

export function normalizeApprovalMode(mode: Mode, approvalMode: ApprovalMode): ApprovalMode {
  return mode === 'orchestrate' || approvalMode !== 'aware' ? approvalMode : 'auto-edit';
}
