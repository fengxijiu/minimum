export type TransactionStatus =
	| "created"
	| "dirty"
	| "validation_failed"
	| "repairing"
	| "validated"
	| "committed"
	| "rolled_back"
	| "blocked"
	| "failed";

export type CheckerType =
	| "syntax"
	| "typecheck"
	| "lint"
	| "test"
	| "build"
	| "pattern"
	| "path_policy"
	| "custom";

export type FailureSeverity = "error" | "warning" | "blocking";

export type FailurePolicyAction =
	| "retain_and_repair"
	| "rollback_with_diff"
	| "feedback_only"
	| "terminate";

export interface DiagnosticEntry {
	file: string;
	line?: number;
	column?: number;
	message: string;
	errorCode?: string;
}

export interface ValidationFailure {
	failureId: string;
	attemptIndex: number;
	checkerType: CheckerType;
	severity: FailureSeverity;
	affectedFiles: string[];
	diagnostics: DiagnosticEntry[];
	failedDiff: string | null;
	command?: string;
	exitCode?: number;
	timestamp: number;
	policy: FailurePolicyAction;
	resolved: boolean;
}

export interface RepairBudget {
	maxAttemptsPerFile: number;
	maxAttemptsPerTask: number;
	sameErrorRepeatLimit: number;
	maxDiffChars: number;
	maxDiagnosticChars: number;
}

export interface RepairState {
	totalAttempts: number;
	perFileAttempts: Map<string, number>;
	errorSignatures: Map<string, number>;
}

export interface TouchedFileEntry {
	action: "modified" | "created" | "deleted" | "renamed";
	preEditSnapshotPath?: string;
	originalPath?: string;
}

export interface TransactionSummary {
	transactionId: string;
	taskId: string;
	personaId: string;
	status: TransactionStatus;
	touchedFiles: string[];
	validatorsRun: string[];
	failures: ValidationFailure[];
	repairAttempts: number;
	unresolvedFailures: ValidationFailure[];
	finalEvidence: string | null;
	applyCommit: string | null;
	rollbackReason: string | null;
	durationMs: number;
}

export type TransactionEvent =
	| { type: "transaction_started"; transactionId: string; taskId: string }
	| {
			type: "transaction_file_touched";
			file: string;
			action: "modified" | "created" | "deleted" | "renamed";
	  }
	| { type: "validation_started"; checkerType: CheckerType }
	| { type: "validation_passed"; checkerType: CheckerType }
	| { type: "validation_failed"; failure: ValidationFailure }
	| { type: "repair_feedback_injected"; attemptIndex: number }
	| { type: "repair_attempt_started"; attemptIndex: number }
	| { type: "repair_attempt_passed"; attemptIndex: number }
	| {
			type: "repair_attempt_failed";
			attemptIndex: number;
			failure: ValidationFailure;
	  }
	| { type: "repair_budget_exhausted"; reason: string }
	| { type: "transaction_validated" }
	| { type: "transaction_committed"; commitSha: string | null }
	| { type: "transaction_rolled_back"; reason: string }
	| { type: "transaction_blocked"; reason: string }
	| { type: "transaction_failed"; reason: string };

export interface TransactionOptions {
	taskId: string;
	personaId: string;
	objective: string;
	acceptance: string[];
	allowedGlobs: string[];
	baseRevision: string | null;
	worktreePath?: string;
}

export const DEFAULT_REPAIR_BUDGET: RepairBudget = {
	maxAttemptsPerFile: 2,
	maxAttemptsPerTask: 4,
	sameErrorRepeatLimit: 2,
	maxDiffChars: 20_000,
	maxDiagnosticChars: 12_000,
};
