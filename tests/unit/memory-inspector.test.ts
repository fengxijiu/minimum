import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	inspectCanonical,
	inspectMemoryIndex,
	inspectStaging,
	refreshMemoryIndex,
	renderMemoryReport,
	writeCandidate,
} from "../../src/memory/governance/index.js";
import { MemoryCommand } from "../../src/commands/index.js";
import type { MemoryCandidate } from "../../src/memory/governance/types.js";

function mkCandidate(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
	return {
		sourceTask: "T2-1",
		persona: "code_executor",
		scope: "backend",
		confidence: "high",
		relatedFiles: ["src/upload.ts"],
		body: "finding",
		...over,
	};
}

describe("inspectCanonical", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-inspect-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("reports declared files and their existence", async () => {
		fs.mkdirSync(path.join(dir, ".minimum"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".minimum", "project.md"), "hello");
		const info = await inspectCanonical(dir);
		const project = info.find((i) => i.key === "project")!;
		expect(project.exists).toBe(true);
		expect(project.bytes).toBe(5);
		const architecture = info.find((i) => i.key === "architecture")!;
		expect(architecture.exists).toBe(false);
	});
});

describe("inspectStaging", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-inspect2-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("lists staged candidates", async () => {
		await writeCandidate(dir, mkCandidate());
		const staging = await inspectStaging(dir);
		expect(staging).toHaveLength(1);
		expect(staging[0]!.sourceTask).toBe("T2-1");
		expect(staging[0]!.confidence).toBe("high");
	});

	it("returns empty when nothing staged", async () => {
		expect(await inspectStaging(dir)).toEqual([]);
	});
});

describe("renderMemoryReport", () => {
	it("renders canonical and staging sections", () => {
		const out = renderMemoryReport(
			[{ key: "project", path: ".minimum/project.md", exists: true, bytes: 10 }],
			[
				{
					id: "T1.vision",
					sourceTask: "T1",
					persona: "vision",
					scope: "ui",
					confidence: "medium",
					relatedFiles: [],
				},
			],
		);
		expect(out).toContain("Canonical memory:");
		expect(out).toContain("project");
		expect(out).toContain("Staging (1 candidate)");
		expect(out).toContain("T1.vision");
	});

	it("renders index status when supplied", () => {
		const out = renderMemoryReport([], [], {
			path: ".minimum/index.json",
			exists: true,
			entryCount: 3,
			missingCount: 1,
		});
		expect(out).toContain("Index:");
		expect(out).toContain("3 entries");
		expect(out).toContain("1 missing");
	});

	it("shows empty markers", () => {
		const out = renderMemoryReport([], []);
		expect(out).toContain("(none declared)");
		expect(out).toContain("(empty)");
	});
});

describe("MemoryCommand", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cmd-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	function ctx() {
		return { workingDirectory: dir, messages: [], config: {} };
	}

	it("status reports canonical and staging", async () => {
		await writeCandidate(dir, mkCandidate());
		await refreshMemoryIndex(dir);
		const r = await new MemoryCommand().execute(["status"], ctx());
		expect(r.success).toBe(true);
		expect(r.output).toContain("Memory status:");
		expect(r.output).toContain("Project canonical:");
		expect(r.output).toContain("Global canonical:");
		expect(r.output).toContain("Staging: 1 candidate");
		expect(r.output).toContain("Index entries:");
		expect(r.output).toContain("Last compacted:");
		expect(r.output).toContain("Injection budget:");
	});

	it("inspectMemoryIndex reports generated index stats", async () => {
		await refreshMemoryIndex(dir);
		const info = await inspectMemoryIndex(dir);
		expect(info.exists).toBe(true);
		expect(info.entryCount).toBeGreaterThan(0);
	});

	it("defaults to status with no args", async () => {
		const r = await new MemoryCommand().execute([], ctx());
		expect(r.success).toBe(true);
		expect(r.output).toContain("Memory status:");
	});

	it("staging reports empty staging", async () => {
		const r = await new MemoryCommand().execute(["staging"], ctx());
		expect(r.success).toBe(true);
		expect(r.output).toContain("Staging (0 candidates)");
		expect(r.output).toContain("(empty)");
	});

	it("approves and rejects staged candidates by id", async () => {
		await writeCandidate(
			dir,
			mkCandidate({ sourceTask: "T1", persona: "code_executor", body: "approved note" }),
		);
		await writeCandidate(
			dir,
			mkCandidate({ sourceTask: "T2", persona: "reviewer", body: "rejected note" }),
		);

		const approve = await new MemoryCommand().execute(["approve", "T1.code_executor"], ctx());
		expect(approve.success).toBe(true);
		expect(approve.output).toContain("Approved staged memory candidate T1.code_executor");
		expect(
			fs.readFileSync(path.join(dir, ".minimum", "project.md"), "utf-8"),
		).toContain("approved note");

		const reject = await new MemoryCommand().execute(["reject", "T2.reviewer"], ctx());
		expect(reject.success).toBe(true);
		expect(reject.output).toContain("Rejected staged memory candidate T2.reviewer");

		const staging = await inspectStaging(dir);
		expect(staging).toEqual([]);
	});

	it("rejects an unknown subcommand", async () => {
		const r = await new MemoryCommand().execute(["frobnicate"], ctx());
		expect(r.success).toBe(false);
		expect(r.output).toContain("Unknown subcommand");
	});
});
