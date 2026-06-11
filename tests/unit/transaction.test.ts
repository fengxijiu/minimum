import { describe, expect, it } from "vitest";
import { TaskTransaction } from "../../src/transaction/TaskTransaction.js";
import { resolveFailurePolicy } from "../../src/transaction/FailurePolicy.js";
import { buildRepairFeedback } from "../../src/transaction/RepairFeedbackBuilder.js";
import {
	checkCompletionGate,
	buildGateBlockMessage,
} from "../../src/transaction/CompletionGate.js";
import { generateHumanReport } from "../../src/transaction/TransactionArtifact.js";
import type {
	ValidationFailure,
	TransactionSummary,
} from "../../src/transaction/types.js";

function makeTx(overrides?: Partial<ConstructorParameters<typeof TaskTransaction>[0]>) {
	return new TaskTransaction(
		{
			taskId: "T-test-1",
			personaId: "code_executor",
			objective: "Fix the login button",
			acceptance: ["Login button works", "No console errors"],
			allowedGlobs: ["src/auth/**"],
			baseRevision: "abc123",
			...overrides,
		},
		{ maxAttemptsPerFile: 2, maxAttemptsPerTask: 4, sameErrorRepeatLimit: 2 },
	);
}

function makeFailure(overrides?: Partial<Omit<ValidationFailure, "failureId" | "attemptIndex" | "timestamp" | "resolved">>) {
	return {
		checkerType: "syntax" as const,
		severity: "error" as const,
		affectedFiles: ["src/auth/login.ts"],
		diagnostics: [{ file: "src/auth/login.ts", line: 10, column: 5, message: "Unexpected token" }],
		failedDiff: null,
		policy: "retain_and_repair" as const,
		...overrides,
	};
}

describe("TaskTransaction", () => {
	describe("state machine", () => {
		it("starts in created state", () => {
			const tx = makeTx();
			expect(tx.status).toBe("created");
		});

		it("transitions created → dirty on file touch", () => {
			const tx = makeTx();
			tx.touchFile("src/auth/login.ts", "modified");
			expect(tx.status).toBe("dirty");
			expect(tx.touchedFiles.has("src/auth/login.ts")).toBe(true);
		});

		it("transitions dirty → validation_failed on failure", () => {
			const tx = makeTx();
			tx.touchFile("src/auth/login.ts", "modified");
			tx.recordFailure(makeFailure());
			expect(tx.status).toBe("validation_failed");
		});

		it("transitions validation_failed → repairing on consumeRepairAttempt", () => {
			const tx = makeTx();
			tx.touchFile("src/auth/login.ts", "modified");
			tx.recordFailure(makeFailure());
			tx.consumeRepairAttempt("src/auth/login.ts", "syntax:src/auth/login.ts::10");
			expect(tx.status).toBe("repairing");
		});

		it("transitions to validated when all failures resolved", () => {
			const tx = makeTx();
			tx.touchFile("src/auth/login.ts", "modified");
			const f = tx.recordFailure(makeFailure());
			tx.consumeRepairAttempt("src/auth/login.ts", "sig");
			tx.resolveFailure(f.failureId);
			expect(tx.status).toBe("validated");
		});

		it("rejects invalid transitions", () => {
			const tx = makeTx();
			expect(() => tx.transitionTo("committed")).toThrow("Invalid transaction transition");
		});

		it("always allows transition to failed from any non-terminal state", () => {
			const tx = makeTx();
			tx.touchFile("f.ts", "modified");
			tx.transitionTo("failed");
			expect(tx.status).toBe("failed");
			expect(tx.isTerminal).toBe(true);
		});

		it("marks terminal states correctly", () => {
			const tx = makeTx();
			tx.touchFile("f.ts", "modified");
			tx.transitionTo("validated");
			tx.transitionTo("committed");
			expect(tx.isTerminal).toBe(true);
			expect(() => tx.transitionTo("failed")).toThrow();
		});
	});

	describe("touched files", () => {
		it("tracks multiple files", () => {
			const tx = makeTx();
			tx.touchFile("a.ts", "modified");
			tx.touchFile("b.ts", "created");
			tx.touchFile("c.ts", "deleted");
			expect(tx.touchedFiles.size).toBe(3);
			expect(tx.touchedFiles.get("b.ts")?.action).toBe("created");
		});

		it("is idempotent for the same file", () => {
			const tx = makeTx();
			tx.touchFile("a.ts", "modified");
			tx.touchFile("a.ts", "modified");
			expect(tx.touchedFiles.size).toBe(1);
		});
	});

	describe("repair budget", () => {
		it("allows repair within budget", () => {
			const tx = makeTx();
			expect(tx.canRepair("a.ts").allowed).toBe(true);
		});

		it("exhausts per-task budget", () => {
			const tx = makeTx();
			for (let i = 0; i < 4; i++) {
				tx.consumeRepairAttempt(`f${i}.ts`, `sig${i}`);
			}
			expect(tx.canRepair().allowed).toBe(false);
			expect(tx.canRepair().reason).toContain("per-task");
		});

		it("exhausts per-file budget", () => {
			const tx = makeTx();
			tx.consumeRepairAttempt("a.ts", "sig1");
			tx.consumeRepairAttempt("a.ts", "sig2");
			expect(tx.canRepair("a.ts").allowed).toBe(false);
			expect(tx.canRepair("a.ts").reason).toContain("per-file");
		});

		it("detects same error repeat", () => {
			const tx = makeTx();
			tx.consumeRepairAttempt("a.ts", "same_sig");
			tx.consumeRepairAttempt("a.ts", "same_sig");
			expect(tx.checkSameErrorRepeat("same_sig")).toBe(true);
		});

		it("returns remaining budget", () => {
			const tx = makeTx();
			tx.consumeRepairAttempt("a.ts", "sig1");
			const remaining = tx.getRemainingBudget();
			expect(remaining.perTask).toBe(3);
		});
	});

	describe("failure recording", () => {
		it("records and tracks failures", () => {
			const tx = makeTx();
			tx.touchFile("a.ts", "modified");
			const f = tx.recordFailure(makeFailure());
			expect(f.failureId).toBeDefined();
			expect(tx.failures.length).toBe(1);
			expect(tx.hasUnresolvedFailures()).toBe(true);
		});

		it("resolves failures", () => {
			const tx = makeTx();
			tx.touchFile("a.ts", "modified");
			const f = tx.recordFailure(makeFailure());
			expect(tx.resolveFailure(f.failureId)).toBe(true);
			expect(tx.hasUnresolvedFailures()).toBe(false);
		});

		it("emits events", () => {
			const tx = makeTx();
			const events: string[] = [];
			tx.onEvent((e) => events.push(e.type));
			tx.touchFile("a.ts", "modified");
			tx.recordFailure(makeFailure());
			// transaction_started fires in constructor before onEvent is attached,
			// so it's in the internal events array but not captured by the callback.
			expect(tx.events.map((e) => e.type)).toContain("transaction_started");
			expect(events).toContain("transaction_file_touched");
			expect(events).toContain("validation_failed");
		});
	});

	describe("summary", () => {
		it("generates a complete summary", () => {
			const tx = makeTx();
			tx.touchFile("a.ts", "modified");
			tx.recordFailure(makeFailure());
			const summary = tx.getSummary();
			expect(summary.taskId).toBe("T-test-1");
			expect(summary.personaId).toBe("code_executor");
			expect(summary.touchedFiles).toEqual(["a.ts"]);
			expect(summary.failures.length).toBe(1);
			expect(summary.unresolvedFailures.length).toBe(1);
			expect(summary.repairAttempts).toBe(0);
		});
	});
});

describe("FailurePolicy", () => {
	it("terminates on path policy violation", () => {
		expect(
			resolveFailurePolicy({
				checkerType: "syntax",
				severity: "error",
				hasWorktree: true,
				isPathPolicyViolation: true,
				isForbiddenGlob: false,
			}),
		).toBe("terminate");
	});

	it("terminates on forbidden glob", () => {
		expect(
			resolveFailurePolicy({
				checkerType: "syntax",
				severity: "error",
				hasWorktree: true,
				isPathPolicyViolation: false,
				isForbiddenGlob: true,
			}),
		).toBe("terminate");
	});

	it("retains and repairs syntax errors in worktree", () => {
		expect(
			resolveFailurePolicy({
				checkerType: "syntax",
				severity: "error",
				hasWorktree: true,
				isPathPolicyViolation: false,
				isForbiddenGlob: false,
			}),
		).toBe("retain_and_repair");
	});

	it("rollbacks with diff when no worktree", () => {
		expect(
			resolveFailurePolicy({
				checkerType: "typecheck",
				severity: "error",
				hasWorktree: false,
				isPathPolicyViolation: false,
				isForbiddenGlob: false,
			}),
		).toBe("rollback_with_diff");
	});

	it("feedback only for warnings", () => {
		expect(
			resolveFailurePolicy({
				checkerType: "pattern",
				severity: "warning",
				hasWorktree: false,
				isPathPolicyViolation: false,
				isForbiddenGlob: false,
			}),
		).toBe("feedback_only");
	});
});

describe("RepairFeedbackBuilder", () => {
	it("includes all required sections", () => {
		const failure: ValidationFailure = {
			failureId: "f_1",
			attemptIndex: 1,
			checkerType: "syntax",
			severity: "error",
			affectedFiles: ["src/auth/login.ts"],
			diagnostics: [{ file: "src/auth/login.ts", line: 10, column: 5, message: "Unexpected token" }],
			failedDiff: null,
			timestamp: Date.now(),
			policy: "retain_and_repair",
			resolved: false,
		};
		const feedback = buildRepairFeedback({
			objective: "Fix login",
			acceptance: ["Login works"],
			failure,
			failedDiff: null,
			touchedFiles: ["src/auth/login.ts"],
			remainingBudget: { perFile: 2, perTask: 3 },
			allowedGlobs: ["src/auth/**"],
		});
		expect(feedback).toContain("[REPAIR REQUIRED]");
		expect(feedback).toContain("Fix login");
		expect(feedback).toContain("Login works");
		expect(feedback).toContain("syntax");
		expect(feedback).toContain("Unexpected token");
		expect(feedback).toContain("src/auth/login.ts");
		expect(feedback).toContain("Per-task attempts left: 3");
		expect(feedback).toContain("src/auth/**");
		expect(feedback).toContain("FIX");
		expect(feedback).toContain("BLOCKED");
		expect(feedback).toContain("FAILED");
	});

	it("truncates large diffs", () => {
		const failure: ValidationFailure = {
			failureId: "f_1",
			attemptIndex: 1,
			checkerType: "syntax",
			severity: "error",
			affectedFiles: ["big.ts"],
			diagnostics: [],
			failedDiff: null,
			timestamp: Date.now(),
			policy: "retain_and_repair",
			resolved: false,
		};
		const bigDiff = "x".repeat(100);
		const feedback = buildRepairFeedback({
			objective: "test",
			acceptance: [],
			failure,
			failedDiff: bigDiff,
			touchedFiles: [],
			remainingBudget: { perFile: 1, perTask: 1 },
			allowedGlobs: [],
			maxDiffChars: 50,
		});
		expect(feedback).toContain("truncated");
	});
});

describe("CompletionGate", () => {
	it("allows completed when validated", () => {
		const gate = checkCompletionGate("validated", "completed", false, false);
		expect(gate.allow).toBe(true);
	});

	it("blocks completed with unresolved failures", () => {
		const gate = checkCompletionGate("validation_failed", "completed", true, false);
		expect(gate.allow).toBe(false);
		if (!gate.allow) {
			expect(gate.requiredAction).toBe("repair");
		}
	});

	it("forces blocked_or_failed when budget exhausted", () => {
		const gate = checkCompletionGate("validation_failed", "completed", true, true);
		expect(gate.allow).toBe(false);
		if (!gate.allow) {
			expect(gate.requiredAction).toBe("blocked_or_failed");
		}
	});

	it("allows blocked report with unresolved failures", () => {
		const gate = checkCompletionGate("validation_failed", "blocked", true, false);
		expect(gate.allow).toBe(true);
	});

	it("allows failed report with unresolved failures", () => {
		const gate = checkCompletionGate("validation_failed", "failed", true, false);
		expect(gate.allow).toBe(true);
	});

	it("advises when no validation ran", () => {
		const gate = checkCompletionGate("dirty", "completed", false, false);
		expect(gate.allow).toBe(true);
		if (gate.allow) {
			expect(gate.advisory).toContain("No validation");
		}
	});

	it("blocks completed on rolled_back transaction", () => {
		const gate = checkCompletionGate("rolled_back", "completed", false, false);
		expect(gate.allow).toBe(false);
	});

	it("builds gate block message", () => {
		const msg = buildGateBlockMessage(
			{ allow: false, reason: "test", requiredAction: "repair" },
			"validation_failed",
			2,
			3,
		);
		expect(msg).toContain("COMPLETION BLOCKED");
		expect(msg).toContain("validation_failed");
		expect(msg).toContain("Unresolved failures: 2");
		expect(msg).toContain("FIX");
	});
});

describe("TransactionArtifact", () => {
	it("generates a human-readable report", () => {
		const summary: TransactionSummary = {
			transactionId: "tx_1",
			taskId: "T-1",
			personaId: "code_executor",
			status: "validated",
			touchedFiles: ["src/a.ts", "src/b.ts"],
			validatorsRun: ["syntax", "typecheck"],
			failures: [],
			repairAttempts: 0,
			unresolvedFailures: [],
			finalEvidence: "All checks passed",
			applyCommit: "abc123",
			rollbackReason: null,
			durationMs: 5000,
		};
		const report = generateHumanReport(summary);
		expect(report).toContain("T-1");
		expect(report).toContain("code_executor");
		expect(report).toContain("validated");
		expect(report).toContain("src/a.ts");
		expect(report).toContain("syntax");
		expect(report).toContain("abc123");
		expect(report).toContain("All checks passed");
	});

	it("includes failure timeline", () => {
		const summary: TransactionSummary = {
			transactionId: "tx_2",
			taskId: "T-2",
			personaId: "test_writer",
			status: "failed",
			touchedFiles: ["tests/a.test.ts"],
			validatorsRun: ["test"],
			failures: [
				{
					failureId: "f_1",
					attemptIndex: 1,
					checkerType: "test",
					severity: "error",
					affectedFiles: ["tests/a.test.ts"],
					diagnostics: [{ file: "tests/a.test.ts", message: "assertion failed" }],
					failedDiff: null,
					timestamp: Date.now(),
					policy: "retain_and_repair",
					resolved: false,
				},
			],
			repairAttempts: 1,
			unresolvedFailures: [
				{
					failureId: "f_1",
					attemptIndex: 1,
					checkerType: "test",
					severity: "error",
					affectedFiles: ["tests/a.test.ts"],
					diagnostics: [{ file: "tests/a.test.ts", message: "assertion failed" }],
					failedDiff: null,
					timestamp: Date.now(),
					policy: "retain_and_repair",
					resolved: false,
				},
			],
			finalEvidence: null,
			applyCommit: null,
			rollbackReason: "repair budget exhausted",
			durationMs: 10000,
		};
		const report = generateHumanReport(summary);
		expect(report).toContain("f_1");
		expect(report).toContain("assertion failed");
		expect(report).toContain("Unresolved");
		expect(report).toContain("repair budget exhausted");
	});
});

describe("End-to-end repair flow", () => {
	it("happy path: write → validate pass → commit", () => {
		const tx = makeTx();
		tx.touchFile("src/auth/login.ts", "modified");
		expect(tx.status).toBe("dirty");
		tx.transitionTo("validated");
		expect(tx.status).toBe("validated");
		expect(tx.hasUnresolvedFailures()).toBe(false);
		const summary = tx.getSummary();
		expect(summary.status).toBe("validated");
	});

	it("repair loop: fail → repair → pass", () => {
		const tx = makeTx();
		tx.touchFile("src/auth/login.ts", "modified");
		const f = tx.recordFailure(makeFailure());
		expect(tx.status).toBe("validation_failed");

		tx.consumeRepairAttempt("src/auth/login.ts", "sig1");
		expect(tx.status).toBe("repairing");

		tx.resolveFailure(f.failureId);
		expect(tx.status).toBe("validated");
		expect(tx.hasUnresolvedFailures()).toBe(false);
		expect(tx.getSummary().repairAttempts).toBe(1);
	});

	it("budget exhaustion: repeated failures → failed", () => {
		const tx = makeTx();
		tx.touchFile("a.ts", "modified");

		for (let i = 0; i < 4; i++) {
			tx.recordFailure(makeFailure({ diagnostics: [{ file: "a.ts", message: `error ${i}` }] }));
			tx.consumeRepairAttempt("a.ts", `unique_sig_${i}`);
		}
		expect(tx.canRepair().allowed).toBe(false);
		expect(tx.getSummary().repairAttempts).toBe(4);
	});

	it("completion gate blocks completed with unresolved failures", () => {
		const tx = makeTx();
		tx.touchFile("a.ts", "modified");
		tx.recordFailure(makeFailure());

		const gate = checkCompletionGate(
			tx.status,
			"completed",
			tx.hasUnresolvedFailures(),
			!tx.canRepair().allowed,
		);
		expect(gate.allow).toBe(false);
	});

	it("multi-file tracking", () => {
		const tx = makeTx();
		tx.touchFile("src/a.ts", "modified");
		tx.touchFile("src/b.ts", "created");
		tx.touchFile("src/c.ts", "deleted");
		tx.touchFile("src/d.ts", "renamed");

		const summary = tx.getSummary();
		expect(summary.touchedFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
	});

	it("worktree vs non-worktree policy branches", () => {
		expect(
			resolveFailurePolicy({ checkerType: "typecheck", severity: "error", hasWorktree: true, isPathPolicyViolation: false, isForbiddenGlob: false }),
		).toBe("retain_and_repair");

		expect(
			resolveFailurePolicy({ checkerType: "typecheck", severity: "error", hasWorktree: false, isPathPolicyViolation: false, isForbiddenGlob: false }),
		).toBe("rollback_with_diff");
	});

	it("path policy violation terminates immediately", () => {
		const tx = makeTx();
		tx.touchFile("a.ts", "modified");
		const policy = resolveFailurePolicy({
			checkerType: "path_policy",
			severity: "error",
			hasWorktree: true,
			isPathPolicyViolation: true,
			isForbiddenGlob: false,
		});
		expect(policy).toBe("terminate");
		tx.setRollbackReason("path policy violation");
		tx.transitionTo("failed");
		expect(tx.isTerminal).toBe(true);
	});
});
