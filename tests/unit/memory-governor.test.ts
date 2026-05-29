import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyFinalize,
	compileFinalize,
	renderEntry,
	upsertSection,
	writeCandidate,
	type Finalize,
} from "../../src/memory/governance/index.js";
import type { MemoryCandidate } from "../../src/memory/governance/types.js";

function mkCandidate(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
	return {
		sourceTask: "T2-1",
		persona: "code_executor",
		scope: "backend",
		confidence: "high",
		relatedFiles: ["src/upload.ts"],
		body: "POST /upload accepts multipart and returns 201.",
		...over,
	};
}

describe("compileFinalize", () => {
	it("parses a valid finalize block", () => {
		const text = `<finalize>{
			"patch_merge_plan": [{"taskId":"T2-1","order":1}],
			"memory_decisions": [
				{"candidateId":"T2-1.code_executor","action":"merge","target":"api.md","section":"Upload","reason":"verified"}
			]
		}</finalize>`;
		const r = compileFinalize(text);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.finalize.patchMergePlan).toEqual([{ taskId: "T2-1", order: 1 }]);
			expect(r.finalize.memoryDecisions[0]!.action).toBe("merge");
			expect(r.finalize.memoryDecisions[0]!.target).toBe("api.md");
		}
	});

	it("rejects a missing block", () => {
		const r = compileFinalize("no finalize");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("missing");
	});

	it("rejects invalid JSON", () => {
		const r = compileFinalize("<finalize>{bad}</finalize>");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("invalid JSON");
	});

	it("rejects an unknown action", () => {
		const r = compileFinalize(
			`<finalize>{"memory_decisions":[{"candidateId":"X","action":"delete","reason":"r"}]}</finalize>`,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("action");
	});

	it("rejects merge without target", () => {
		const r = compileFinalize(
			`<finalize>{"memory_decisions":[{"candidateId":"X","action":"merge","reason":"r"}]}</finalize>`,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("target");
	});

	it("rejects a decision without reason", () => {
		const r = compileFinalize(
			`<finalize>{"memory_decisions":[{"candidateId":"X","action":"reject"}]}</finalize>`,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("reason");
	});

	it("allows an empty finalize", () => {
		const r = compileFinalize(`<finalize>{}</finalize>`);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.finalize.patchMergePlan).toEqual([]);
			expect(r.finalize.memoryDecisions).toEqual([]);
		}
	});
});

describe("upsertSection", () => {
	it("creates a section when the file is empty", () => {
		const out = upsertSection("", "API", "hello", "append");
		expect(out).toContain("## API");
		expect(out).toContain("hello");
	});

	it("appends under an existing section, keeping prior content", () => {
		const text = "# Title\n\n## API\n\nfirst entry\n";
		const out = upsertSection(text, "API", "second entry", "append");
		expect(out.indexOf("first entry")).toBeLessThan(out.indexOf("second entry"));
	});

	it("replaces section content in replace mode", () => {
		const text = "## API\n\nold content\n";
		const out = upsertSection(text, "API", "new content", "replace");
		expect(out).toContain("new content");
		expect(out).not.toContain("old content");
	});

	it("appends a new section without disturbing others", () => {
		const text = "## A\n\nalpha\n\n## B\n\nbeta\n";
		const out = upsertSection(text, "C", "gamma", "append");
		expect(out).toContain("alpha");
		expect(out).toContain("beta");
		expect(out).toContain("## C");
		expect(out).toContain("gamma");
	});

	it("does not bleed into the next section when appending", () => {
		const text = "## A\n\nalpha\n\n## B\n\nbeta\n";
		const out = upsertSection(text, "A", "alpha2", "append");
		const aIdx = out.indexOf("## A");
		const bIdx = out.indexOf("## B");
		expect(out.indexOf("alpha2")).toBeGreaterThan(aIdx);
		expect(out.indexOf("alpha2")).toBeLessThan(bIdx);
	});

	it("treats '## ' inside a code fence as content, not a heading boundary", () => {
		const text = "## A\n\n```\n## not a heading\nx\n```\n\n## B\n\nbeta\n";
		const out = upsertSection(text, "A", "alpha2", "append");
		// the appended entry must land after the whole fence, before ## B
		const fenceEnd = out.lastIndexOf("```");
		const bIdx = out.indexOf("## B");
		expect(out.indexOf("alpha2")).toBeGreaterThan(fenceEnd);
		expect(out.indexOf("alpha2")).toBeLessThan(bIdx);
		expect(out).toContain("## not a heading");
	});

	it("preserves blank lines inside a fenced code block in the body", () => {
		const body = "```\nconst a = 1;\n\n\nconst b = 2;\n```";
		const out = upsertSection("## API\n\nfirst\n", "API", body, "append");
		expect(out).toContain("const a = 1;\n\n\nconst b = 2;");
	});
});

describe("renderEntry", () => {
	it("embeds provenance for invariant #4", () => {
		const out = renderEntry(mkCandidate());
		expect(out).toContain("source_task=T2-1");
		expect(out).toContain("persona=code_executor");
		expect(out).toContain("related_files=src/upload.ts");
	});
});

describe("applyFinalize", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-gov-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	function finalize(decisions: Finalize["memoryDecisions"]): Finalize {
		return { patchMergePlan: [], memoryDecisions: decisions };
	}

	it("merges a candidate into a canonical file with provenance", async () => {
		const c = mkCandidate();
		const report = await applyFinalize(
			dir,
			finalize([
				{ candidateId: "T2-1.code_executor", action: "merge", target: "api.md", section: "Upload", reason: "verified" },
			]),
			[c],
		);
		expect(report.errors).toEqual([]);
		const written = fs.readFileSync(path.join(dir, ".minimum", "api.md"), "utf-8");
		expect(written).toContain("## Upload");
		expect(written).toContain("returns 201");
		expect(written).toContain("source_task=T2-1");
	});

	it("records an error for an unknown candidate id", async () => {
		const report = await applyFinalize(
			dir,
			finalize([{ candidateId: "ghost.vision", action: "merge", target: "x.md", reason: "r" }]),
			[mkCandidate()],
		);
		expect(report.errors[0]!.error).toContain("not found");
	});

	it("archives a candidate to _archive/YYYY-MM/", async () => {
		const c = mkCandidate();
		const now = new Date(Date.UTC(2026, 4, 1)); // 2026-05
		const report = await applyFinalize(
			dir,
			finalize([{ candidateId: "T2-1.code_executor", action: "archive", reason: "superseded" }]),
			[c],
			{ now },
		);
		const archived = report.applied.find((a) => a.action === "archive");
		expect(archived!.path).toContain(path.join("_archive", "2026-05"));
		expect(fs.existsSync(archived!.path!)).toBe(true);
	});

	it("reject performs no write", async () => {
		const report = await applyFinalize(
			dir,
			finalize([{ candidateId: "T2-1.code_executor", action: "reject", reason: "low value" }]),
			[mkCandidate()],
		);
		expect(report.applied[0]!.path).toBeUndefined();
		expect(fs.existsSync(path.join(dir, ".minimum", "api.md"))).toBe(false);
	});

	it("clears staging after applying (invariant #3)", async () => {
		const c = mkCandidate();
		await writeCandidate(dir, c);
		expect(fs.existsSync(path.join(dir, ".minimum", "_staging", "T2-1.code_executor.memory.md"))).toBe(true);

		const report = await applyFinalize(
			dir,
			finalize([{ candidateId: "T2-1.code_executor", action: "merge", target: "api.md", section: "Upload", reason: "ok" }]),
			[c],
		);
		expect(report.stagingCleared).toBe(true);
		expect(fs.existsSync(path.join(dir, ".minimum", "_staging", "T2-1.code_executor.memory.md"))).toBe(false);
	});

	it("update replaces the target section body", async () => {
		fs.mkdirSync(path.join(dir, ".minimum"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".minimum", "api.md"), "## Upload\n\nold spec\n");
		const c = mkCandidate({ body: "new spec v2" });
		await applyFinalize(
			dir,
			finalize([{ candidateId: "T2-1.code_executor", action: "update", target: "api.md", section: "Upload", reason: "rev" }]),
			[c],
		);
		const written = fs.readFileSync(path.join(dir, ".minimum", "api.md"), "utf-8");
		expect(written).toContain("new spec v2");
		expect(written).not.toContain("old spec");
	});
});
