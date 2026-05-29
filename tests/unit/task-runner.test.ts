import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskContract } from "../../src/orchestration/index.js";
import {
	extractXmlBlock,
	runTask,
	type WorkerExecutor,
} from "../../src/orchestration/index.js";
import { listCandidates } from "../../src/memory/governance/index.js";

function mkContract(over: Partial<TaskContract> = {}): TaskContract {
	return {
		taskId: "T-run-1",
		phase: "P0",
		epicId: "E",
		personaId: "code_executor",
		objective: "implement upload handler",
		inputs: { userGoal: "image upload", artifacts: [], constraints: [] },
		pathPolicy: { allowedGlobs: ["src/upload.ts"], forbiddenGlobs: [] },
		acceptance: ["uploads a file"],
		outputSchema: "task_report",
		parallelGroup: "impl",
		dependsOn: [],
		abortOnConflict: false,
		...over,
	};
}

function stubExecutor(output: string): WorkerExecutor {
	return { run: async () => output };
}

function throwingExecutor(msg: string): WorkerExecutor {
	return {
		run: async () => {
			throw new Error(msg);
		},
	};
}

describe("extractXmlBlock", () => {
	it("extracts content between tags", () => {
		expect(extractXmlBlock("<task_report>hello</task_report>", "task_report")).toBe("hello");
	});

	it("returns empty string when tag is missing", () => {
		expect(extractXmlBlock("no tags here", "task_report")).toBe("");
	});

	it("returns empty string when closing tag is missing", () => {
		expect(extractXmlBlock("<task_report>unclosed", "task_report")).toBe("");
	});

	it("trims whitespace from extracted content", () => {
		expect(extractXmlBlock("<foo>  bar  </foo>", "foo")).toBe("bar");
	});
});

describe("runTask", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-runner-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("returns contract_invalid when validation fails", async () => {
		const bad = mkContract({ objective: "x" }); // too short
		const r = await runTask(bad, { projectRoot: dir, executor: stubExecutor("") });
		expect(r.status).toBe("contract_invalid");
		expect(r.errors.length).toBeGreaterThan(0);
		expect(r.report).toBe("");
	});

	it("returns ok when executor emits a task_report", async () => {
		const output = `<task_report><status>ok</status>\nDone.</task_report>`;
		const r = await runTask(mkContract(), { projectRoot: dir, executor: stubExecutor(output) });
		expect(r.status).toBe("ok");
		expect(r.report).toContain("Done.");
		expect(r.errors).toEqual([]);
	});

	it("returns blocked when report contains blocked status", async () => {
		const output = `<task_report><status>blocked</status>\nWaiting.</task_report>`;
		const r = await runTask(mkContract(), { projectRoot: dir, executor: stubExecutor(output) });
		expect(r.status).toBe("blocked");
	});

	it("returns error when executor throws", async () => {
		const r = await runTask(mkContract(), {
			projectRoot: dir,
			executor: throwingExecutor("network failure"),
		});
		expect(r.status).toBe("error");
		expect(r.errors[0]).toContain("network failure");
	});

	it("returns error when output has no task_report block", async () => {
		const r = await runTask(mkContract(), { projectRoot: dir, executor: stubExecutor("nothing") });
		expect(r.status).toBe("error");
	});

	it("includes durationMs in result", async () => {
		const output = `<task_report><status>ok</status></task_report>`;
		const r = await runTask(mkContract(), { projectRoot: dir, executor: stubExecutor(output) });
		expect(r.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("persists memory candidate to staging when present", async () => {
		const output = [
			`<task_report><status>ok</status></task_report>`,
			`<memory_candidate>`,
			`scope: architecture`,
			`confidence: high`,
			`related_files:`,
			`  - src/upload.ts`,
			``,
			`## Stack decision`,
			`Use Vite.`,
			`</memory_candidate>`,
		].join("\n");

		const r = await runTask(mkContract(), { projectRoot: dir, executor: stubExecutor(output) });
		expect(r.memoryCandidateBody).toBeDefined();

		const candidates = await listCandidates(dir);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]!.scope).toBe("architecture");
		expect(candidates[0]!.confidence).toBe("high");
		expect(candidates[0]!.relatedFiles).toContain("src/upload.ts");
		expect(candidates[0]!.body).toContain("Use Vite.");
	});

	it("does not persist when no memory candidate emitted", async () => {
		const output = `<task_report><status>ok</status></task_report>`;
		await runTask(mkContract(), { projectRoot: dir, executor: stubExecutor(output) });
		const candidates = await listCandidates(dir);
		expect(candidates).toHaveLength(0);
	});

	it("passes filtered tool list to executor", async () => {
		const seen: string[][] = [];
		const executor: WorkerExecutor = {
			run: async (_contract, tools) => {
				seen.push(tools);
				return `<task_report><status>ok</status></task_report>`;
			},
		};
		await runTask(mkContract(), { projectRoot: dir, executor });
		expect(seen).toHaveLength(1);
		// code_executor allowlist should be non-empty, denylist removes exec_shell
		expect(seen[0]!).not.toContain("exec_shell");
	});

	it("works with a read-only persona (no allowedGlobs required)", async () => {
		const contract = mkContract({
			taskId: "T-review-1",
			personaId: "reviewer",
			outputSchema: "review_report",
			pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		});
		const output = `<task_report><status>ok</status>\nLGTM</task_report>`;
		const r = await runTask(contract, { projectRoot: dir, executor: stubExecutor(output) });
		expect(r.status).toBe("ok");
	});
});
