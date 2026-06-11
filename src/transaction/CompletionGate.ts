import type { TransactionStatus } from "./types.js";

export type GateDecision =
	| { allow: true; advisory?: string }
	| { allow: false; reason: string; requiredAction: "repair" | "blocked_or_failed" };

export function checkCompletionGate(
	transactionStatus: TransactionStatus,
	workerReportStatus: string | undefined,
	hasUnresolvedFailures: boolean,
	repairBudgetExhausted: boolean,
): GateDecision {
	const isCompleted = !workerReportStatus || workerReportStatus === "completed" || workerReportStatus === "ok";
	const isBlockedOrFailed =
		workerReportStatus === "blocked" ||
		workerReportStatus === "failed" ||
		workerReportStatus === "error";

	if (transactionStatus === "validated" || transactionStatus === "committed") {
		return { allow: true };
	}

	if (transactionStatus === "failed" || transactionStatus === "rolled_back") {
		if (isCompleted) {
			return {
				allow: false,
				reason: `Transaction is ${transactionStatus}; cannot report completed.`,
				requiredAction: "blocked_or_failed",
			};
		}
		return { allow: true };
	}

	if (transactionStatus === "blocked") {
		return { allow: true };
	}

	if (
		(transactionStatus === "validation_failed" || transactionStatus === "repairing") &&
		isCompleted
	) {
		if (hasUnresolvedFailures) {
			return {
				allow: false,
				reason: "Unresolved validation failures exist; cannot report completed.",
				requiredAction: repairBudgetExhausted ? "blocked_or_failed" : "repair",
			};
		}
		return { allow: true };
	}

	if (repairBudgetExhausted && isCompleted) {
		return {
			allow: false,
			reason: "Repair budget exhausted; must report blocked or failed.",
			requiredAction: "blocked_or_failed",
		};
	}

	if (isCompleted && !hasUnresolvedFailures) {
		if (transactionStatus === "created" || transactionStatus === "dirty") {
			return {
				allow: true,
				advisory: "No validation was run during this task.",
			};
		}
		return { allow: true };
	}

	if (isBlockedOrFailed) {
		return { allow: true };
	}

	return { allow: true };
}

export function buildGateBlockMessage(
	decision: Extract<GateDecision, { allow: false }>,
	transactionStatus: TransactionStatus,
	unresolvedCount: number,
	remainingPerTask: number,
): string {
	const lines = [
		"[COMPLETION BLOCKED] You cannot report completed while validation failures are unresolved.",
		`Transaction status: ${transactionStatus}`,
		`Unresolved failures: ${unresolvedCount}`,
	];

	if (remainingPerTask > 0) {
		lines.push(
			"You must FIX the failures, or report BLOCKED/FAILED.",
		);
	} else {
		lines.push(
			"Repair budget exhausted. Report BLOCKED or FAILED with evidence.",
		);
	}

	return lines.join("\n");
}
