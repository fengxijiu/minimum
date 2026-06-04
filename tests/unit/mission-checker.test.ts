import { describe, expect, it } from "vitest";
import {
	compileMissionCheck,
	loopBackTasksToCoarseTasks,
} from "../../src/orchestration/index.js";

describe("compileMissionCheck", () => {
	it("parses an approved report", () => {
		const result = compileMissionCheck(`# W3.5 Loop Detection Report

## 1. Final Decision

Decision: APPROVED_TO_W4

Reason:

- All required behavior is complete.
`);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.report.decision).toBe("APPROVED_TO_W4");
		expect(result.report.tasks).toEqual([]);
		expect(result.report.reason).toContain("All required behavior");
	});

	it("parses loop-back tasks and maps owner agents", () => {
		const result = compileMissionCheck(`# W3.5 Loop Detection Report

## 1. Final Decision

Decision: LOOP_BACK_TO_W1

Reason:

- Missing validation path.

## 7. Loop-Back Tasks for W1

### Task 1: Add failed upload validation

- Priority: P1
- Blocking: Yes
- Reason: Failed uploads currently skip validation.
- Source issue: W3 test report did not cover rejected files.
- Expected outcome: Rejected files return a useful error.
- Suggested owner agent: test_writer
- Allowed globs:
  - src/upload.ts
  - tests/upload.test.ts
- Acceptance criteria:
  - Adds a rejected-file test.
  - Test fails before implementation and passes after.
`);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.report.decision).toBe("LOOP_BACK_TO_W1");
		expect(result.report.tasks).toHaveLength(1);
		expect(result.report.tasks[0]!.personaId).toBe("test_writer");
		expect(result.report.tasks[0]!.blocking).toBe(true);
		expect(result.report.tasks[0]!.acceptance).toContain("Adds a rejected-file test.");
		expect(result.report.tasks[0]!.allowedGlobs).toEqual(["src/upload.ts", "tests/upload.test.ts"]);
	});

	it("accepts a code_executor repair leg for the dynamic repair loop", () => {
		// Method 2: the W3.5 -> code_executor repair task is the implementation leg
		// of the runtime code_executor -> test_runner -> code_executor loop. With a
		// concrete owner and globs it must compile cleanly.
		const result = compileMissionCheck(`# W3.5 Loop Detection Report

## 1. Final Decision

Decision: LOOP_BACK_TO_W1

Reason:

- Upload size limit still unimplemented.

## 7. Loop-Back Tasks for W1

### Task 1: Implement 5MB upload rejection

- Priority: P1
- Blocking: Yes
- Reason: test_runner reported "rejects files >5MB" failing.
- Source issue: T-verify test failure on oversize upload.
- Expected outcome: POST /upload returns 413 for >5MB and \`npm test\` passes.
- Suggested owner agent: code_executor
- Allowed globs:
  - src/api/upload.ts
- Acceptance criteria:
  - Files over 5MB return 413.
  - Existing happy-path upload tests stay green.
`);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.report.decision).toBe("LOOP_BACK_TO_W1");
		expect(result.report.tasks).toHaveLength(1);
		expect(result.report.tasks[0]!.personaId).toBe("code_executor");
		expect(result.report.tasks[0]!.allowedGlobs).toEqual(["src/api/upload.ts"]);

		const coarse = loopBackTasksToCoarseTasks(result.report.tasks, 0);
		expect(coarse[0]).toMatchObject({
			personaId: "code_executor",
			needsRefine: true,
			allowedGlobs: ["src/api/upload.ts"],
		});
	});

	it("parses human confirmation as a blocking decision", () => {
		const result = compileMissionCheck(`Decision: NEEDS_HUMAN_CONFIRMATION`);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.report.decision).toBe("NEEDS_HUMAN_CONFIRMATION");
	});

	it("tolerates markdown emphasis around the decision value", () => {
		const bold = compileMissionCheck(`Decision: **NEEDS_HUMAN_CONFIRMATION**`);
		expect(bold.ok).toBe(true);
		if (bold.ok) expect(bold.report.decision).toBe("NEEDS_HUMAN_CONFIRMATION");

		const ticks = compileMissionCheck("Decision: `APPROVED_TO_W4`");
		expect(ticks.ok).toBe(true);
		if (ticks.ok) expect(ticks.report.decision).toBe("APPROVED_TO_W4");

		const italic = compileMissionCheck(`Decision: _LOOP_BACK_TO_W1_`);
		expect(italic.ok).toBe(true);
		if (italic.ok) expect(italic.report.decision).toBe("LOOP_BACK_TO_W1");
	});

	it("tolerates markdown emphasis in loop-back task fields", () => {
		const result = compileMissionCheck(`# W3.5 Loop Detection Report

Decision: **LOOP_BACK_TO_W1**

Reason:

- Missing validation path.

## 7. Loop-Back Tasks for W1

### Task 1: Add failed upload validation

- Priority: **P1**
- Blocking: **Yes**
- Reason: Failed uploads currently skip validation.
- Source issue: W3 test report did not cover rejected files.
- Expected outcome: Rejected files return a useful error.
- Suggested owner agent: \`test_writer\`
- Acceptance criteria:
  - Adds a rejected-file test.
`);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.report.decision).toBe("LOOP_BACK_TO_W1");
		expect(result.report.tasks).toHaveLength(1);
		expect(result.report.tasks[0]!.priority).toBe("P1");
		expect(result.report.tasks[0]!.blocking).toBe(true);
		expect(result.report.tasks[0]!.personaId).toBe("test_writer");
	});

	it("does not approve invalid reports", () => {
		const result = compileMissionCheck("looks good to me");
		expect(result.ok).toBe(false);
	});

	it("rejects loop-back code tasks that cannot form usable contracts", () => {
		const result = compileMissionCheck(`# W3.5 Loop Detection Report

Decision: LOOP_BACK_TO_W1

Reason:

- Missing validation path.

## 7. Loop-Back Tasks for W1

### Task 1: Patch upload edge case

- Priority: P1
- Blocking: Yes
- Reason: Upload accepts invalid files.
- Source issue: W3.5 found rejected files are not handled.
- Expected outcome: Invalid files return a clear error.
- Suggested owner agent: code_executor
- Acceptance criteria:
  - Invalid files return a clear error.
`);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("usable contracts");
			expect(result.error).toContain("requires Allowed globs");
		}
	});

	it("rejects loop-back tasks with conflicting allowed globs", () => {
		const result = compileMissionCheck(`# W3.5 Loop Detection Report

Decision: LOOP_BACK_TO_W1

Reason:

- Two patches target the same file.

## 7. Loop-Back Tasks for W1

### Task 1: Patch upload edge case

- Priority: P1
- Blocking: Yes
- Reason: Upload accepts invalid files.
- Source issue: W3.5 found rejected files are not handled.
- Expected outcome: Invalid files return a clear error.
- Suggested owner agent: code_executor
- Allowed globs:
  - src/upload.ts
- Acceptance criteria:
  - Invalid files return a clear error.

### Task 2: Patch upload response

- Priority: P1
- Blocking: Yes
- Reason: Upload response is inconsistent.
- Source issue: W3.5 found response mismatch.
- Expected outcome: Upload response shape is stable.
- Suggested owner agent: code_executor
- Allowed globs:
  - src/upload.ts
- Acceptance criteria:
  - Upload response shape is stable.
`);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("conflicts");
			expect(result.error).toContain("src/upload.ts");
		}
	});
});

describe("loopBackTasksToCoarseTasks", () => {
	it("creates repair coarse tasks that must pass through refinement", () => {
		const tasks = loopBackTasksToCoarseTasks(
			[
				{
					title: "Patch missing edge case",
					priority: "P1",
					blocking: true,
					reason: "Missing branch",
					sourceIssue: "W3.5",
					expectedOutcome: "Edge case is covered",
					personaId: "code_executor",
					acceptance: ["done"],
					allowedGlobs: ["src/edge.ts"],
				},
			],
			0,
		);
		expect(tasks[0]).toMatchObject({
			id: "T3.5-1-1",
			personaId: "code_executor",
			parallelGroup: "mission-repair-1",
			needsRefine: true,
			allowedGlobs: ["src/edge.ts"],
			acceptance: ["done"],
			priority: "P1",
			sourceIssue: "W3.5",
			blocking: true,
		});
	});
});
