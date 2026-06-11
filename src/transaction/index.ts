export type {
	TransactionStatus,
	CheckerType,
	FailureSeverity,
	FailurePolicyAction,
	DiagnosticEntry,
	ValidationFailure,
	RepairBudget,
	RepairState,
	TouchedFileEntry,
	TransactionSummary,
	TransactionEvent,
	TransactionOptions,
} from "./types.js";

export { DEFAULT_REPAIR_BUDGET } from "./types.js";

export { TaskTransaction } from "./TaskTransaction.js";
export { resolveFailurePolicy } from "./FailurePolicy.js";
export type { PolicyContext } from "./FailurePolicy.js";
export { buildRepairFeedback } from "./RepairFeedbackBuilder.js";
export type { RepairFeedbackInput } from "./RepairFeedbackBuilder.js";
export { checkCompletionGate, buildGateBlockMessage } from "./CompletionGate.js";
export type { GateDecision } from "./CompletionGate.js";
export { generateHumanReport } from "./TransactionArtifact.js";
