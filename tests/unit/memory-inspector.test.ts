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

describe("inspectMemoryIndex", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-cmd-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("reports generated index stats", async () => {
		await refreshMemoryIndex(dir);
		const info = await inspectMemoryIndex(dir);
		expect(info.exists).toBe(true);
		expect(info.entryCount).toBeGreaterThan(0);
	});
});
