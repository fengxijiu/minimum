import type {
	TransactionStatus,
	TransactionOptions,
	TransactionEvent,
	TransactionSummary,
	ValidationFailure,
	RepairBudget,
	RepairState,
	TouchedFileEntry,
} from "./types.js";
import { DEFAULT_REPAIR_BUDGET } from "./types.js";

const VALID_TRANSITIONS: Record<TransactionStatus, TransactionStatus[]> = {
	created: ["dirty", "validation_failed", "blocked", "failed"],
	dirty: ["validation_failed", "validated", "blocked", "failed"],
	validation_failed: ["repairing", "validated", "rolled_back", "blocked", "failed"],
	repairing: ["validation_failed", "validated", "dirty", "blocked", "failed"],
	validated: ["committed", "blocked", "failed"],
	committed: [],
	rolled_back: ["failed"],
	blocked: [],
	failed: [],
};

const TERMINAL_STATUSES = new Set<TransactionStatus>([
	"committed",
	"rolled_back",
	"blocked",
	"failed",
]);

let transactionCounter = 0;

export type TransactionEventCallback = (event: TransactionEvent) => void;

export class TaskTransaction {
	readonly id: string;
	readonly taskId: string;
	readonly personaId: string;
	readonly objective: string;
	readonly acceptance: string[];
	readonly allowedGlobs: string[];
	readonly baseRevision: string | null;
	readonly worktreePath: string | undefined;

	private _status: TransactionStatus = "created";
	private _touchedFiles = new Map<string, TouchedFileEntry>();
	private _failures: ValidationFailure[] = [];
	private _validatorsRun = new Set<string>();
	private _repairState: RepairState = {
		totalAttempts: 0,
		perFileAttempts: new Map(),
		errorSignatures: new Map(),
	};
	private _events: TransactionEvent[] = [];
	private _finalEvidence: string | null = null;
	private _applyCommit: string | null = null;
	private _rollbackReason: string | null = null;
	private _startTime: number;
	private _eventCallbacks: TransactionEventCallback[] = [];
	private readonly _budget: RepairBudget;
	private _failureCounter = 0;

	constructor(opts: TransactionOptions, budget?: Partial<RepairBudget>) {
		this.id = `tx_${Date.now()}_${++transactionCounter}`;
		this.taskId = opts.taskId;
		this.personaId = opts.personaId;
		this.objective = opts.objective;
		this.acceptance = opts.acceptance;
		this.allowedGlobs = opts.allowedGlobs;
		this.baseRevision = opts.baseRevision;
		this.worktreePath = opts.worktreePath;
		this._budget = { ...DEFAULT_REPAIR_BUDGET, ...budget };
		this._startTime = Date.now();

		this._emit({
			type: "transaction_started",
			transactionId: this.id,
			taskId: this.taskId,
		});
	}

	get status(): TransactionStatus {
		return this._status;
	}

	get touchedFiles(): Map<string, TouchedFileEntry> {
		return new Map(this._touchedFiles);
	}

	get failures(): readonly ValidationFailure[] {
		return this._failures;
	}

	get repairBudget(): RepairBudget {
		return { ...this._budget };
	}

	get events(): readonly TransactionEvent[] {
		return this._events;
	}

	get isTerminal(): boolean {
		return TERMINAL_STATUSES.has(this._status);
	}

	onEvent(callback: TransactionEventCallback): void {
		this._eventCallbacks.push(callback);
	}

	touchFile(
		filePath: string,
		action: TouchedFileEntry["action"],
		opts?: { originalPath?: string },
	): void {
		if (!this._touchedFiles.has(filePath)) {
			this._touchedFiles.set(filePath, {
				action,
				originalPath: opts?.originalPath,
			});
			this._emit({
				type: "transaction_file_touched",
				file: filePath,
				action,
			});
		}
		if (this._status === "created") {
			this.transitionTo("dirty");
		}
	}

	recordFailure(failure: Omit<ValidationFailure, "failureId" | "attemptIndex" | "timestamp" | "resolved">): ValidationFailure {
		this._failureCounter++;
		const full: ValidationFailure = {
			...failure,
			failureId: `f_${this._failureCounter}`,
			attemptIndex: this._repairState.totalAttempts + 1,
			timestamp: Date.now(),
			resolved: false,
		};
		this._failures.push(full);
		this._validatorsRun.add(failure.checkerType);

		if (this._status !== "validation_failed") {
			this.transitionTo("validation_failed");
		}

		this._emit({ type: "validation_failed", failure: full });
		return full;
	}

	resolveFailure(failureId: string): boolean {
		const failure = this._failures.find((f) => f.failureId === failureId);
		if (!failure || failure.resolved) return false;
		failure.resolved = true;

		if (!this.hasUnresolvedFailures() && this._status !== "validated") {
			this.transitionTo("validated");
		}
		return true;
	}

	hasUnresolvedFailures(): boolean {
		return this._failures.some((f) => !f.resolved);
	}

	canRepair(file?: string): { allowed: boolean; reason?: string } {
		if (this.isTerminal) {
			return { allowed: false, reason: "transaction is in terminal state" };
		}
		if (this._repairState.totalAttempts >= this._budget.maxAttemptsPerTask) {
			return { allowed: false, reason: "per-task repair budget exhausted" };
		}
		if (file) {
			const fileAttempts = this._repairState.perFileAttempts.get(file) ?? 0;
			if (fileAttempts >= this._budget.maxAttemptsPerFile) {
				return { allowed: false, reason: `per-file repair budget exhausted for ${file}` };
			}
		}
		return { allowed: true };
	}

	consumeRepairAttempt(file: string, errorSignature: string): void {
		this._repairState.totalAttempts++;
		this._repairState.perFileAttempts.set(
			file,
			(this._repairState.perFileAttempts.get(file) ?? 0) + 1,
		);
		this._repairState.errorSignatures.set(
			errorSignature,
			(this._repairState.errorSignatures.get(errorSignature) ?? 0) + 1,
		);
		if (this._status === "validation_failed") {
			this.transitionTo("repairing");
		}
		this._emit({
			type: "repair_attempt_started",
			attemptIndex: this._repairState.totalAttempts,
		});
	}

	checkSameErrorRepeat(errorSignature: string): boolean {
		const count = this._repairState.errorSignatures.get(errorSignature) ?? 0;
		return count >= this._budget.sameErrorRepeatLimit;
	}

	getRemainingBudget(): { perFile: number; perTask: number } {
		return {
			perFile: this._budget.maxAttemptsPerFile,
			perTask: this._budget.maxAttemptsPerTask - this._repairState.totalAttempts,
		};
	}

	transitionTo(newStatus: TransactionStatus): void {
		if (newStatus === this._status) return;

		const allowed = VALID_TRANSITIONS[this._status];
		if (!allowed.includes(newStatus)) {
			throw new Error(
				`Invalid transaction transition: ${this._status} → ${newStatus}`,
			);
		}
		this._status = newStatus;

		switch (newStatus) {
			case "validated":
				this._emit({ type: "transaction_validated" });
				break;
			case "rolled_back":
				this._emit({ type: "transaction_rolled_back", reason: this._rollbackReason ?? "unknown" });
				break;
			case "blocked":
				this._emit({ type: "transaction_blocked", reason: "worker reported blocked" });
				break;
			case "failed":
				this._emit({ type: "transaction_failed", reason: "transaction failed" });
				break;
		}
	}

	setCommitSha(sha: string | null): void {
		this._applyCommit = sha;
		this._emit({ type: "transaction_committed", commitSha: sha });
	}

	setRollbackReason(reason: string): void {
		this._rollbackReason = reason;
	}

	setFinalEvidence(evidence: string): void {
		this._finalEvidence = evidence;
	}

	recordValidatorRun(checkerType: string): void {
		this._validatorsRun.add(checkerType);
	}

	getSummary(): TransactionSummary {
		return {
			transactionId: this.id,
			taskId: this.taskId,
			personaId: this.personaId,
			status: this._status,
			touchedFiles: [...this._touchedFiles.keys()],
			validatorsRun: [...this._validatorsRun],
			failures: this._failures,
			repairAttempts: this._repairState.totalAttempts,
			unresolvedFailures: this._failures.filter((f) => !f.resolved),
			finalEvidence: this._finalEvidence,
			applyCommit: this._applyCommit,
			rollbackReason: this._rollbackReason,
			durationMs: Date.now() - this._startTime,
		};
	}

	private _emit(event: TransactionEvent): void {
		this._events.push(event);
		for (const cb of this._eventCallbacks) {
			try {
				cb(event);
			} catch {
				// Event callback faults must not break the transaction.
			}
		}
	}
}
