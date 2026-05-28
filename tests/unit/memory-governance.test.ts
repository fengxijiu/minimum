import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	candidateFilename,
	clearForEpic,
	defaultManifest,
	getOrInitManifest,
	listCandidates,
	parseCandidate,
	parseYaml,
	score,
	serializeCandidate,
	shouldPersist,
	shouldRequireSecondReview,
	stagingPath,
	writeCandidate,
	writeManifest,
} from "../../src/memory/governance/index.js";
import type { MemoryCandidate } from "../../src/memory/governance/index.js";

function mkCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
	return {
		sourceTask: "T-A1-1",
		persona: "code_executor",
		scope: "frontend/upload",
		confidence: "high",
		relatedFiles: ["frontend/src/components/Upload.tsx"],
		body: "## Observations\n- Component uses tailwind utilities.",
		...overrides,
	};
}

describe("MemoryStaging", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-staging-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("candidateFilename combines task id and persona", () => {
		expect(candidateFilename("T-A1-1", "vision")).toBe("T-A1-1.vision.memory.md");
	});

	it("writes and lists a candidate", async () => {
		const c = mkCandidate();
		await writeCandidate(dir, c);
		const found = await listCandidates(dir);
		expect(found).toHaveLength(1);
		expect(found[0]!.sourceTask).toBe(c.sourceTask);
		expect(found[0]!.body).toContain("tailwind");
	});

	it("returns empty list when staging dir does not exist", async () => {
		const r = await listCandidates(path.join(dir, "absent"));
		expect(r).toEqual([]);
	});

	it("clearForEpic removes only matching task ids", async () => {
		await writeCandidate(dir, mkCandidate({ sourceTask: "T-1" }));
		await writeCandidate(dir, mkCandidate({ sourceTask: "T-2" }));
		await clearForEpic(dir, ["T-1"]);
		const remaining = await listCandidates(dir);
		expect(remaining).toHaveLength(1);
		expect(remaining[0]!.sourceTask).toBe("T-2");
	});

	it("writing same (task, persona) twice overwrites", async () => {
		await writeCandidate(dir, mkCandidate({ body: "## A\nfirst" }));
		await writeCandidate(dir, mkCandidate({ body: "## A\nsecond" }));
		const found = await listCandidates(dir);
		expect(found).toHaveLength(1);
		expect(found[0]!.body).toContain("second");
	});

	it("survives malformed candidate files", async () => {
		const sdir = stagingPath(dir);
		fs.mkdirSync(sdir, { recursive: true });
		fs.writeFileSync(path.join(sdir, "broken.memory.md"), "not frontmatter");
		await writeCandidate(dir, mkCandidate({ sourceTask: "T-ok" }));
		const found = await listCandidates(dir);
		expect(found).toHaveLength(1);
		expect(found[0]!.sourceTask).toBe("T-ok");
	});

	describe("serializeCandidate / parseCandidate roundtrip", () => {
		it("preserves all fields", () => {
			const original = mkCandidate({ relatedFiles: ["a.ts", "b.ts"] });
			const text = serializeCandidate(original);
			const parsed = parseCandidate(text)!;
			expect(parsed.sourceTask).toBe(original.sourceTask);
			expect(parsed.persona).toBe(original.persona);
			expect(parsed.scope).toBe(original.scope);
			expect(parsed.confidence).toBe(original.confidence);
			expect(parsed.relatedFiles).toEqual(original.relatedFiles);
		});

		it("handles empty related_files via [] inline", () => {
			const text = `---\nsource_task: T-1\npersona: vision\nscope: none\nconfidence: low\nrelated_files: []\n---\n\n(empty)\n`;
			const parsed = parseCandidate(text);
			expect(parsed).not.toBeNull();
			expect(parsed!.relatedFiles).toEqual([]);
		});

		it("rejects unknown confidence", () => {
			const text = `---\nsource_task: T-1\npersona: vision\nscope: x\nconfidence: certain\nrelated_files: []\n---\n\nbody\n`;
			expect(parseCandidate(text)).toBeNull();
		});

		it("rejects missing required fields", () => {
			const text = `---\nsource_task: T-1\nconfidence: high\n---\n\nbody\n`;
			expect(parseCandidate(text)).toBeNull();
		});
	});
});

describe("MemoryManifest", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-manifest-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("getOrInitManifest creates default manifest when missing", async () => {
		const m = await getOrInitManifest(dir);
		expect(m.version).toBe(1);
		expect(m.canonicalFiles.architecture).toBe(".minimum/architecture.md");
		expect(fs.existsSync(path.join(dir, ".minimum", "manifest.yaml"))).toBe(true);
	});

	it("write/read roundtrip preserves canonical files map", async () => {
		const m = defaultManifest();
		m.canonicalFiles.custom = ".minimum/custom.md";
		await writeManifest(dir, m);
		const loaded = await getOrInitManifest(dir);
		expect(loaded.canonicalFiles.custom).toBe(".minimum/custom.md");
	});

	it("write/read preserves rules", async () => {
		const m = defaultManifest();
		m.rules.requireEvidenceForMemory = false;
		await writeManifest(dir, m);
		const loaded = await getOrInitManifest(dir);
		expect(loaded.rules.requireEvidenceForMemory).toBe(false);
		expect(loaded.rules.subagentsCanWriteCanonical).toBe(false);
	});

	it("write/read preserves load_policy lists", async () => {
		const m = defaultManifest();
		await writeManifest(dir, m);
		const loaded = await getOrInitManifest(dir);
		expect(loaded.loadPolicy.always).toEqual([
			"project", "architecture", "repo_map", "conventions", "tests",
		]);
		expect(loaded.loadPolicy.frontend).toContain("visual");
	});

	it("parseYaml strips comments", () => {
		const yaml = `version: 1  # comment\nmemory_root: ".minimum"\n`;
		expect(parseYaml(yaml).version).toBe(1);
		expect(parseYaml(yaml).memoryRoot).toBe(".minimum");
	});
});

describe("MemoryScorer", () => {
	it("scores a strong candidate above persistence threshold", () => {
		const s = score(mkCandidate({
			body: "## API Contract\nNew endpoint POST /upload returns image_id. Must validate MIME type.",
			relatedFiles: ["a.ts", "b.ts", "c.ts"],
		}));
		expect(shouldPersist(s)).toBe(true);
	});

	it("rejects low-confidence candidates", () => {
		const s = score(mkCandidate({ confidence: "low" }));
		expect(shouldPersist(s)).toBe(false);
	});

	it("rejects no-evidence candidates (empty relatedFiles, short body)", () => {
		const s = score(mkCandidate({ relatedFiles: [], body: "noop", scope: "none" }));
		expect(shouldPersist(s)).toBe(false);
	});

	it("flags security-related candidates for second review", () => {
		const s = score(mkCandidate({
			body: "## Risk\nUploaded files must validate MIME; do not trust extension. Auth required.",
		}));
		expect(shouldRequireSecondReview(s)).toBe(true);
	});

	it("does not flag harmless candidates for second review", () => {
		const s = score(mkCandidate({
			body: "## Observations\nComponent uses tailwind utility classes.",
		}));
		expect(shouldRequireSecondReview(s)).toBe(false);
	});

	it("penalizes ephemeral wording in stability", () => {
		const ephemeral = score(mkCandidate({
			body: "Workaround for now: hack the loader. TODO replace.",
		}));
		const stable = score(mkCandidate({
			body: "## Convention\nAll API routers register in router.py.",
		}));
		expect(ephemeral.stability).toBeLessThan(stable.stability);
	});
});
