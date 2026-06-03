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
		nonGoals: ["do not change unrelated upload flows"],
		blockedCondition: "blocked if upload handler context is missing",
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

	it("accepts case-insensitive tags", () => {
		expect(extractXmlBlock("<Task_Report>done</TASK_REPORT>", "task_report")).toBe("done");
	});

	it("accepts opening tag attributes", () => {
		expect(extractXmlBlock('<task_report status="ok">done</task_report>', "task_report")).toBe("done");
	});

	it("accepts whitespace inside tag delimiters", () => {
		expect(extractXmlBlock("< task_report >done</ task_report >", "task_report")).toBe("done");
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

	it("does not repair when executor emits a task_report with attributes", async () => {
		let calls = 0;
		const executor: WorkerExecutor = {
			run: async () => {
				calls++;
				return `<task_report status="ok"><status>ok</status>\nDone.</task_report>`;
			},
		};
		const r = await runTask(mkContract(), { projectRoot: dir, executor });
		expect(r.status).toBe("ok");
		expect(r.schemaRepairAttempted).toBeUndefined();
		expect(calls).toBe(1);
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
		expect(r.schemaRepairAttempted).toBe(true);
	});

	it("surfaces a descriptive error and raw excerpt when task_report is missing", async () => {
		const rawOutput = "I cannot complete this task because the upstream context is unclear.";
		const r = await runTask(mkContract(), { projectRoot: dir, executor: stubExecutor(rawOutput) });
		expect(r.status).toBe("error");
		expect(r.errors.length).toBeGreaterThan(0);
		expect(r.errors.join("\n")).toMatch(/task_report/i);
		expect(r.errors.join("\n")).toContain("upstream context is unclear");
	});

	it("uses an explanatory error when worker output is empty", async () => {
		const r = await runTask(mkContract(), { projectRoot: dir, executor: stubExecutor("") });
		expect(r.status).toBe("error");
		expect(r.errors.length).toBeGreaterThan(0);
		expect(r.errors.join("\n")).toMatch(/empty|no output/i);
	});

	it("retries once and succeeds when schema repair returns a valid task_report", async () => {
		let calls = 0;
		const executor: WorkerExecutor = {
			run: async (_contract, _tools, repair) => {
				calls++;
				if (!repair) return "I started analyzing the repo layout.";
				return {
					text: `<task_report><status>ok</status>\nRecovered.</task_report>`,
					attempt: repair.attempt,
					hitStepLimit: false,
				};
			},
		};
		const r = await runTask(mkContract(), { projectRoot: dir, executor });
		expect(r.status).toBe("ok");
		expect(r.report).toContain("Recovered.");
		expect(r.schemaRepairAttempted).toBe(true);
		expect(calls).toBe(2);
	});

	it("reports step-limit-specific schema failures after the retry", async () => {
		const executor: WorkerExecutor = {
			run: async (_contract, _tools, repair) => {
				if (!repair) return { text: "partial analysis", hitStepLimit: true };
				return { text: "still partial", hitStepLimit: true, attempt: repair.attempt };
			},
		};
		const r = await runTask(mkContract(), { projectRoot: dir, executor });
		expect(r.status).toBe("error");
		expect(r.hitStepLimit).toBe(true);
		expect(r.errors.join("\n")).toMatch(/maxSteps|step limit/i);
		expect(r.errors.join("\n")).toMatch(/schema repair retry/i);
	});

	it("reports missing closing tag from the initial attempt when repair fails", async () => {
		const executor: WorkerExecutor = {
			run: async (_contract, _tools, repair) => {
				if (!repair) return "<task_report><status>ok</status>\nAlmost done.";
				return "";
			},
		};
		const r = await runTask(mkContract(), { projectRoot: dir, executor });
		const errors = r.errors.join("\n");
		expect(r.status).toBe("error");
		expect(errors).toContain("initial parse: task_report: opening tag found but closing tag is missing");
		expect(errors).toContain("initial raw excerpt: <task_report><status>ok</status> Almost done.");
		expect(errors).toContain("repair parse: task_report: output is empty");
	});

	it("preserves first-attempt raw excerpt when repair returns empty output", async () => {
		const executor: WorkerExecutor = {
			run: async (_contract, _tools, repair) => {
				if (!repair) return "I gathered context but forgot the XML envelope.";
				return "";
			},
		};
		const r = await runTask(mkContract(), { projectRoot: dir, executor });
		const errors = r.errors.join("\n");
		expect(errors).toContain("initial raw excerpt: I gathered context but forgot the XML envelope.");
		expect(errors).toContain("repair parse: task_report: output is empty");
	});

	it("asks schema repair for only the minimal task_report block", async () => {
		let feedback = "";
		const executor: WorkerExecutor = {
			run: async (_contract, _tools, repair) => {
				if (!repair) return "plain text";
				feedback = repair.feedback;
				return "";
			},
		};
		await runTask(mkContract(), { projectRoot: dir, executor });
		expect(feedback).toContain("one <task_report> block only");
		expect(feedback).toContain("Do not include <memory_candidate> during schema repair");
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
			outputSchema: "task_report",
			pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		});
		const output = `<task_report><status>ok</status>\nLGTM</task_report>`;
		const r = await runTask(contract, { projectRoot: dir, executor: stubExecutor(output) });
		expect(r.status).toBe("ok");
	});
});
