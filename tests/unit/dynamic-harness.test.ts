import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessEvent, TaskContract, WorkerExecutor } from "../../src/orchestration/index.js";
import { DynamicHarness } from "../../src/orchestration/index.js";

function mkContract(over: Partial<TaskContract> = {}): TaskContract {
	return {
		taskId: "T-dyn-1",
		phase: "P0",
		epicId: "E",
		personaId: "code_executor",
		objective: "implement upload handler",
		inputs: { userGoal: "image upload", artifacts: [], constraints: [] },
		pathPolicy: { allowedGlobs: ["src/x.ts"], forbiddenGlobs: [] },
		acceptance: ["done"],
		nonGoals: ["do not modify unrelated files"],
		blockedCondition: "blocked if required dynamic context is missing",
		outputSchema: "task_report",
		parallelGroup: "g",
		dependsOn: [],
		grantedSkills: [],
		grantedMcpTools: [],
		abortOnConflict: false,
		...over,
	};
}

describe("DynamicHarness", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-dynamic-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("records downstream skipped results when an upstream task is skipped", async () => {
		const executor: WorkerExecutor = {
			run: async (contract) => {
				if (contract.taskId === "T1") throw new Error("network error");
				return `<task_report><status>ok</status></task_report>`;
			},
		};
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] } });
		const b = mkContract({ taskId: "T2", dependsOn: ["T1"], pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] } });

		const results = await new DynamicHarness().runToCompletion([a, b], {
			projectRoot: dir,
			executor,
		});

		expect(results.find((r) => r.taskId === "T1")?.status).toBe("skipped");
		expect(results.find((r) => r.taskId === "T2")?.status).toBe("skipped");
		expect(results.find((r) => r.taskId === "T2")?.skipReason).toContain("upstream T1 skipped");
	});

	/**
	 * Executor that tracks peak concurrency by recording how many run() calls
	 * are in-flight at once. Each call yields to the macrotask queue so that any
	 * tasks the harness launches together are observed as concurrently active.
	 */
	function trackingExecutor(): { executor: WorkerExecutor; peak: () => number } {
		let active = 0;
		let max = 0;
		const executor: WorkerExecutor = {
			run: async () => {
				active++;
				max = Math.max(max, active);
				await new Promise((r) => setTimeout(r, 5));
				active--;
				return `<task_report><status>ok</status></task_report>`;
			},
		};
		return { executor, peak: () => max };
	}

	it("serialises independent tasks whose write globs overlap", async () => {
		const { executor, peak } = trackingExecutor();
		// Both tasks write src/shared.ts and have no dependency between them.
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["src/shared.ts"], forbiddenGlobs: [] } });
		const b = mkContract({ taskId: "T2", pathPolicy: { allowedGlobs: ["src/shared.ts"], forbiddenGlobs: [] } });

		const events: HarnessEvent[] = [];
		const results = await new DynamicHarness().runToCompletion([a, b], {
			projectRoot: dir,
			executor,
			onEvent: (e) => events.push(e),
		});

		// Write-lock serialisation: never both running at once.
		expect(peak()).toBe(1);
		// Both still complete successfully (serially).
		expect(results.filter((r) => r.status === "ok")).toHaveLength(2);
		// The blocked task surfaced a write_lock_wait event for observability.
		expect(events.some((e) => e.type === "write_lock_wait")).toBe(true);
	});

	it("runs independent tasks with disjoint write globs in parallel", async () => {
		const { executor, peak } = trackingExecutor();
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["src/a.ts"], forbiddenGlobs: [] } });
		const b = mkContract({ taskId: "T2", pathPolicy: { allowedGlobs: ["src/b.ts"], forbiddenGlobs: [] } });

		const results = await new DynamicHarness().runToCompletion([a, b], {
			projectRoot: dir,
			executor,
		});

		// Disjoint globs → no lock conflict → both run concurrently.
		expect(peak()).toBe(2);
		expect(results.filter((r) => r.status === "ok")).toHaveLength(2);
	});

	// ── F1: launch gate (launchRequirements / artifact gate) ──────────────────

	it("defers a downstream whose required upstream artifact is missing", async () => {
		const ran: string[] = [];
		const executor: WorkerExecutor = {
			run: async (contract) => {
				ran.push(contract.taskId);
				// T1 finishes ok but never emits the <file_list> its dependent needs.
				return `<task_report><status>ok</status><summary>done</summary><changed_files>- a.ts</changed_files></task_report>`;
			},
		};
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] } });
		const b = mkContract({
			taskId: "T2",
			dependsOn: ["T1"],
			pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] },
			launchRequirements: [{ sourceTaskId: "T1", artifact: "file_list", required: true }],
		});

		const events: HarnessEvent[] = [];
		const results = await new DynamicHarness().runToCompletion([a, b], {
			projectRoot: dir,
			executor,
			onEvent: (e) => events.push(e),
		});

		// T2 is held at the launch gate, never executed.
		expect(ran).toEqual(["T1"]);
		expect(results.find((r) => r.taskId === "T1")?.status).toBe("ok");
		expect(results.find((r) => r.taskId === "T2")).toBeUndefined();
		// Gate emits a resource_wait for the deferred task and the queue goes idle.
		expect(events.some((e) => e.type === "resource_wait" && e.taskId === "T2")).toBe(true);
		expect(events.some((e) => e.type === "queue_idle")).toBe(true);
	});

	it("launches the downstream once the required artifact is present", async () => {
		const ran: string[] = [];
		const executor: WorkerExecutor = {
			run: async (contract) => {
				ran.push(contract.taskId);
				if (contract.taskId === "T1") {
					return `<task_report><status>ok</status><summary>done</summary><changed_files>- a.ts</changed_files><file_list>src/a.ts</file_list></task_report>`;
				}
				return `<task_report><status>ok</status><summary>done</summary><changed_files>- b.ts</changed_files></task_report>`;
			},
		};
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] } });
		const b = mkContract({
			taskId: "T2",
			dependsOn: ["T1"],
			pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] },
			launchRequirements: [{ sourceTaskId: "T1", artifact: "file_list", required: true }],
		});

		const results = await new DynamicHarness().runToCompletion([a, b], {
			projectRoot: dir,
			executor,
		});

		expect(ran.sort()).toEqual(["T1", "T2"]);
		expect(results.filter((r) => r.status === "ok")).toHaveLength(2);
	});

	// ── F2: degraded upstream → read-only fallback instead of skip ────────────

	it("lets a downstream proceed when a repo_scout upstream degrades to read-only fallback", async () => {
		const ran: string[] = [];
		const executor: WorkerExecutor = {
			run: async (contract) => {
				ran.push(contract.taskId);
				// repo_scout scan keeps failing with a retryable error → runTaskWithRetry
				// exhausts its attempts and returns a "degraded" result with read-only
				// fallback access (rather than a hard failure).
				if (contract.personaId === "repo_scout") throw new Error("network error");
				return `<task_report><status>ok</status></task_report>`;
			},
		};
		const scout = mkContract({
			taskId: "T1",
			personaId: "repo_scout",
			pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		});
		const downstream = mkContract({
			taskId: "T2",
			dependsOn: ["T1"],
			pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] },
			// Requires a scout artifact but has no explicit fallback → eligible for the
			// read-only fallback path in canUseReadonlyFallback.
			launchRequirements: [{ sourceTaskId: "T1", artifact: "file_list", required: true }],
		});

		const results = await new DynamicHarness().runToCompletion([scout, downstream], {
			projectRoot: dir,
			executor,
		});

		// Upstream degraded, but the downstream still ran (not skipped).
		expect(results.find((r) => r.taskId === "T1")?.status).toBe("degraded");
		expect(ran).toContain("T2");
		expect(results.find((r) => r.taskId === "T2")?.status).toBe("ok");
	});
});
