import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectStaging, listCandidates, renderMemoryReport } from "../../src/memory/governance/index.js";
import type { MemoryCandidate } from "../../src/memory/governance/index.js";
import { MemoryWriter, decideMemory } from "../../src/memory/single/MemoryWriter.js";

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
	return {
		sourceTask: "T-pref",
		persona: "code_executor",
		scope: "global/user-preferences",
		confidence: "high",
		relatedFiles: ["src/index.ts"],
		body: "User prefers concise TypeScript answers. This preference is stable and should be reused as a convention.",
		...overrides,
	};
}

describe("MemoryWriter", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-memory-writer-"));
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("auto-merges low-risk global user preferences into canonical markdown with provenance", async () => {
		const writer = new MemoryWriter({ projectRoot: dir });
		const result = await writer.write(candidate(), { target: "global.md", section: "Preferences" });

		expect(result.decision).toBe("merge");
		expect(fs.existsSync(result.stagingPath)).toBe(false);
		const canonical = fs.readFileSync(path.join(dir, ".minimum", "global.md"), "utf-8");
		expect(canonical).toContain("## Preferences");
		expect(canonical).toContain("User prefers concise TypeScript answers");
		expect(canonical).toContain("<!-- mimo-memory source_task=T-pref persona=code_executor related_files=src/index.ts -->");
	});

	it("keeps safety, credential, and identity-related global memory in staging for /memory review", async () => {
		const writer = new MemoryWriter({ projectRoot: dir });
		const result = await writer.write(candidate({
			sourceTask: "T-secret",
			body: "User identity and credential token handling rules must be remembered as a stable security convention.",
		}), { target: "global.md" });

		expect(result.decision).toBe("needs_review");
		expect(fs.existsSync(result.stagingPath)).toBe(true);
		expect(fs.existsSync(path.join(dir, ".minimum", "global.md"))).toBe(false);
		const staged = await listCandidates(dir);
		expect(staged[0]!.decision).toBe("needs_review");
		const report = renderMemoryReport([], await inspectStaging(dir));
		expect(report).toContain("needs_review");
		expect(report).toContain("Global memory requires review");
	});

	it("rejects low-value candidates after first writing them to staging", async () => {
		const writer = new MemoryWriter({ projectRoot: dir });
		const lowValue = candidate({
			sourceTask: "T-noise",
			scope: "none",
			confidence: "low",
			relatedFiles: [],
			body: "temporary note",
		});

		const result = await writer.write(lowValue);

		expect(result.decision).toBe("reject");
		expect(result.stagingPath).toContain("_staging");
		expect(fs.existsSync(result.stagingPath)).toBe(false);
		expect(await listCandidates(dir)).toEqual([]);
	});

	it("archives deprecated candidates and removes them from staging", async () => {
		const writer = new MemoryWriter({ projectRoot: dir, now: new Date(Date.UTC(2026, 5, 1)) });
		const result = await writer.write(candidate({
			sourceTask: "T-archive",
			scope: "backend",
			body: "This backend convention is deprecated and should be archived because it was superseded by the new API contract.",
		}));

		expect(result.decision).toBe("archive");
		expect(result.archivePath).toContain(path.join("_archive", "2026-06"));
		expect(fs.existsSync(result.archivePath!)).toBe(true);
		expect(fs.existsSync(result.stagingPath)).toBe(false);
	});

	it("exposes needs_review as a MemoryDecision", () => {
		expect(decideMemory(candidate({ body: "User identity must be remembered as a stable security convention." }), undefined, "global.md")).toBe("needs_review");
	});
});
