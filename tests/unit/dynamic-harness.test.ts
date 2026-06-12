import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "../../src/orchestration/HarnessEvent.js";
import type { TaskContract } from "../../src/orchestration/TaskContract.js";
import type { WorkerExecutor } from "../../src/orchestration/TaskRunner.js";
import { DynamicHarness } from "../../src/orchestration/DynamicHarness.js";
import { classifyRoutePolicy } from "../../src/orchestration/RoutePolicy.js";
import {
	getPersona,
	registerPersonaForTesting,
	type Persona,
} from "../../src/personas/index.js";

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
			retryBackoff: { sleep: async (_ms: number) => {} },
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
			run: async (contract) => {
				active++;
				max = Math.max(max, active);
				await new Promise((r) => setTimeout(r, 5));
				active--;
				if (contract.personaId === "reviewer") {
					return `<task_report><status>ok</status><decision>approve</decision><risk_level>low</risk_level></task_report>`;
				}
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

	it("releases the write lock during retry backoff so an overlapping task runs in the gap (#6)", async () => {
		// T1 writes shared.ts and fails once with a retryable error, then succeeds on
		// its second attempt. T2 writes the same file. While T1 sleeps in backoff it
		// must release its write lock so T2 can run in that window — the two never
		// write concurrently (serialised in time), but T2 is not blocked for T1's
		// whole retry. Observed run order proves T2 ran inside T1's backoff gap.
		// Record task_started order (not executor-call order, which includes
		// schema-repair re-emits) — that is what proves T2 ran inside T1's gap.
		const order: string[] = [];
		let t1Attempts = 0;
		// Complete report so code_executor's required blocks don't trigger a repair.
		const okReport = "<task_report><status>ok</status><summary>done</summary><changed_files>- x.ts</changed_files></task_report>";
		const executor: WorkerExecutor = {
			run: async (contract) => {
				if (contract.taskId === "T1") {
					t1Attempts++;
					if (t1Attempts === 1) throw new Error("network error");
				}
				return okReport;
			},
		};
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["src/shared.ts"], forbiddenGlobs: [] } });
		const b = mkContract({ taskId: "T2", pathPolicy: { allowedGlobs: ["src/shared.ts"], forbiddenGlobs: [] } });

		const results = await new DynamicHarness().runToCompletion([a, b], {
			projectRoot: dir,
			executor,
			// Backoff that yields the event loop so T2 can be scheduled in the gap.
			retryBackoff: { sleep: async () => { await new Promise((r) => setTimeout(r, 0)); } },
			onEvent: (e) => {
				if (e.type === "task_started") order.push(`start:${e.taskId}`);
				if (e.type === "task_done") order.push(`done:${e.result.taskId}`);
			},
		});

		// Both succeed.
		expect(results.filter((r) => r.status === "ok")).toHaveLength(2);
		// The decisive proof: T2 STARTED before T1 finished. Without releasing the
		// write lock during backoff, T2 could only start after T1's task_done.
		expect(order.indexOf("start:T2")).toBeLessThan(order.indexOf("done:T1"));
	});

	it("skips write-lock serialisation when worktree isolation is on", async () => {
		const { executor, peak } = trackingExecutor();
		// Same overlapping glob as the serialisation test, but each task now runs in
		// its own worktree — write locks are skipped so both run concurrently.
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["src/shared.ts"], forbiddenGlobs: [] } });
		const b = mkContract({ taskId: "T2", pathPolicy: { allowedGlobs: ["src/shared.ts"], forbiddenGlobs: [] } });

		const events: HarnessEvent[] = [];
		const results = await new DynamicHarness().runToCompletion([a, b], {
			projectRoot: dir,
			executor,
			worktreeIsolation: true,
			onEvent: (e) => events.push(e),
		});

		// Isolation skips write locks → overlapping globs run in parallel.
		expect(peak()).toBe(2);
		expect(results.filter((r) => r.status === "ok")).toHaveLength(2);
		// No write-lock contention is surfaced because the gate is disabled.
		expect(events.some((e) => e.type === "write_lock_wait")).toBe(false);
	});

	it("honors an injected global concurrency cap as the single authority", async () => {
		const { executor, peak } = trackingExecutor();
		// Two disjoint-glob, same-persona tasks would normally run in parallel (cap 2),
		// but a global cap of 1 must serialise them — proving ResourceManager's global
		// cap is the binding authority, not a hardcoded 99.
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["src/a.ts"], forbiddenGlobs: [] } });
		const b = mkContract({ taskId: "T2", pathPolicy: { allowedGlobs: ["src/b.ts"], forbiddenGlobs: [] } });

		const results = await new DynamicHarness().runToCompletion([a, b], {
			projectRoot: dir,
			executor,
			globalConcurrency: 1,
		});

		expect(peak()).toBe(1);
		expect(results.filter((r) => r.status === "ok")).toHaveLength(2);
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

	it("uses route policy persona caps instead of hardcoded cap 5", async () => {
		const { executor, peak } = trackingExecutor();
		const reviewers = Array.from({ length: 4 }, (_, index) => mkContract({
			taskId: `T-R${index + 1}`,
			personaId: "reviewer",
			objective: `review scoped audit surface ${index + 1}`,
			inputs: { userGoal: "repo-wide dead code audit", artifacts: [], constraints: [] },
			pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		}));

		const results = await new DynamicHarness().runToCompletion(reviewers, {
			projectRoot: dir,
			executor,
			routePolicy: classifyRoutePolicy("repo-wide dead code audit", { route: "audit_review", scale: "large" }),
		});

		expect(peak()).toBe(3);
		expect(results.filter((r) => r.status === "ok")).toHaveLength(4);
	});

	it("uses a newly registered persona concurrency cap", async () => {
		const fake: Persona = {
			...getPersona("reviewer"),
			id: "contract_reviewer",
			systemPrompt: "Contract reviewer prompt",
			requiredReportBlocks: [],
			parallelism: { soloPerWave: false, maxConcurrent: 1 },
			orchestration: {
				stage: "review",
				routeRoles: ["audit_review"],
				chainRole: "review",
				executionDepth: "fast",
				planGate: "never",
				producesArtifacts: [],
				repairAliases: ["contract review"],
			},
		};
		const restore = registerPersonaForTesting(fake);
		try {
			const { executor, peak } = trackingExecutor();
			const tasks = Array.from({ length: 2 }, (_, index) => mkContract({
				taskId: `T-C${index + 1}`,
				personaId: "contract_reviewer",
				objective: `review contract surface ${index + 1}`,
				pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
			}));

			const results = await new DynamicHarness().runToCompletion(tasks, {
				projectRoot: dir,
				executor,
			});

			expect(peak()).toBe(1);
			expect(results.filter((r) => r.status === "ok")).toHaveLength(2);
		} finally {
			restore();
		}
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
		// #1 — a permanently-deferred task must still be flushed into results as a
		// terminal status, not silently dropped (results count must match contracts).
		const deferredT2 = results.find((r) => r.taskId === "T2");
		expect(deferredT2).toBeDefined();
		expect(["skipped", "blocked"]).toContain(deferredT2?.status);
		// Gate emits a resource_wait for the deferred task and the queue goes idle.
		expect(events.some((e) => e.type === "resource_wait" && e.taskId === "T2")).toBe(true);
		expect(events.some((e) => e.type === "queue_idle")).toBe(true);
	});

	it("flushes every non-terminal task into results so the count matches contracts (#1)", async () => {
		const executor: WorkerExecutor = {
			run: async () => `<task_report><status>ok</status><summary>done</summary></task_report>`,
		};
		// T1 ok; T2 needs an artifact T1 never emits → deferred; T3 depends on T2.
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] } });
		const b = mkContract({
			taskId: "T2",
			dependsOn: ["T1"],
			pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] },
			launchRequirements: [{ sourceTaskId: "T1", artifact: "file_list", required: true }],
		});
		const c = mkContract({ taskId: "T3", dependsOn: ["T2"], pathPolicy: { allowedGlobs: ["c.ts"], forbiddenGlobs: [] } });

		const results = await new DynamicHarness().runToCompletion([a, b, c], { projectRoot: dir, executor });

		expect(results.map((r) => r.taskId).sort()).toEqual(["T1", "T2", "T3"]);
		expect(results.find((r) => r.taskId === "T2")?.status).toBeDefined();
		expect(results.find((r) => r.taskId === "T3")?.status).toBeDefined();
	});

	it("emits queue_idle with diagnostics naming the stuck task (#10)", async () => {
		const executor: WorkerExecutor = {
			run: async () => `<task_report><status>ok</status><summary>done</summary><changed_files>- a.ts</changed_files></task_report>`,
		};
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] } });
		const b = mkContract({
			taskId: "T2",
			dependsOn: ["T1"],
			pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] },
			launchRequirements: [{ sourceTaskId: "T1", artifact: "file_list", required: true }],
		});

		const events: HarnessEvent[] = [];
		await new DynamicHarness().runToCompletion([a, b], {
			projectRoot: dir,
			executor,
			onEvent: (e) => events.push(e),
		});

		const idle = events.find((e) => e.type === "queue_idle");
		expect(idle).toBeDefined();
		if (idle?.type === "queue_idle") {
			// Diagnostics must point at the stuck downstream so a TUI / W3.5 can act
			// instead of the harness exiting silently.
			expect(idle.deferred).toBeGreaterThan(0);
			expect(idle.diagnostics.some((d) => d.taskId === "T2")).toBe(true);
		}
	});

	it("terminates instead of hanging when no task can ever be scheduled (#3)", async () => {
		const executor: WorkerExecutor = {
			run: async () => `<task_report><status>ok</status></task_report>`,
		};
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] } });

		// globalConcurrency 0 → acquire() can never succeed and nothing runs. The
		// harness must detect no-progress and exit rather than await a wake forever.
		const results = await new DynamicHarness().runToCompletion([a], {
			projectRoot: dir,
			executor,
			globalConcurrency: 0,
		});

		expect(results.find((r) => r.taskId === "T1")?.status).toBeDefined();
	});

	it("aborts in-flight work and flushes the remainder when the signal fires (#9)", async () => {
		const controller = new AbortController();
		const ran: string[] = [];
		const executor: WorkerExecutor = {
			run: async (contract) => {
				ran.push(contract.taskId);
				if (contract.taskId === "T1") controller.abort();
				return `<task_report><status>ok</status></task_report>`;
			},
		};
		const a = mkContract({ taskId: "T1", pathPolicy: { allowedGlobs: ["a.ts"], forbiddenGlobs: [] } });
		const b = mkContract({ taskId: "T2", dependsOn: ["T1"], pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] } });

		const results = await new DynamicHarness().runToCompletion([a, b], {
			projectRoot: dir,
			executor,
			signal: controller.signal,
		});

		// T1 ran and aborted the signal; T2 must never start and be flushed terminal.
		expect(ran).not.toContain("T2");
		const abortedT2 = results.find((r) => r.taskId === "T2");
		expect(abortedT2?.status).toBe("skipped");
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
			retryBackoff: { sleep: async (_ms: number) => {} },
		});

		// Upstream degraded, but the downstream still ran (not skipped).
		expect(results.find((r) => r.taskId === "T1")?.status).toBe("degraded");
		expect(ran).toContain("T2");
		expect(results.find((r) => r.taskId === "T2")?.status).toBe("ok");
	});

	// ── #7: cross-phase launch gate via injected priorResults ─────────────────

	it("defers a task whose cross-phase requirement is unmet, using injected priorResults", async () => {
		const ran: string[] = [];
		const executor: WorkerExecutor = {
			run: async (contract) => {
				ran.push(contract.taskId);
				return `<task_report><status>ok</status><summary>done</summary><changed_files>- b.ts</changed_files></task_report>`;
			},
		};
		// T2's launch requirement points at a W1 perception task NOT in this
		// invocation. The harness must evaluate it against priorResults rather than
		// silently dropping it — the prior result has no <file_list>, so T2 defers.
		const b = mkContract({
			taskId: "T2",
			pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] },
			launchRequirements: [{ sourceTaskId: "W1-scout", artifact: "file_list", required: true }],
		});

		const results = await new DynamicHarness().runToCompletion([b], {
			projectRoot: dir,
			executor,
			priorResults: [{
				taskId: "W1-scout",
				personaId: "repo_scout",
				status: "ok",
				report: "<task_report><status>ok</status><summary>scanned</summary></task_report>",
				memoryCandidateBody: undefined,
				errors: [],
				durationMs: 1,
			}],
		});

		expect(ran).not.toContain("T2");
		expect(["skipped", "blocked"]).toContain(results.find((r) => r.taskId === "T2")?.status);
	});

	it("launches a task whose cross-phase requirement is satisfied by priorResults", async () => {
		const ran: string[] = [];
		const executor: WorkerExecutor = {
			run: async (contract) => {
				ran.push(contract.taskId);
				return `<task_report><status>ok</status><summary>done</summary><changed_files>- b.ts</changed_files></task_report>`;
			},
		};
		const b = mkContract({
			taskId: "T2",
			pathPolicy: { allowedGlobs: ["b.ts"], forbiddenGlobs: [] },
			launchRequirements: [{ sourceTaskId: "W1-scout", artifact: "file_list", required: true }],
		});

		const results = await new DynamicHarness().runToCompletion([b], {
			projectRoot: dir,
			executor,
			priorResults: [{
				taskId: "W1-scout",
				personaId: "repo_scout",
				status: "ok",
				report: "<task_report><status>ok</status><summary>scanned</summary><file_list>src/a.ts</file_list></task_report>",
				memoryCandidateBody: undefined,
				errors: [],
				durationMs: 1,
			}],
		});

		expect(ran).toContain("T2");
		expect(results.find((r) => r.taskId === "T2")?.status).toBe("ok");
	});
});
