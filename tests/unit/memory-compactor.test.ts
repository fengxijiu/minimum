import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryCompactor } from "../../src/memory/single/MemoryCompactor.js";
import { defaultManifest, readMemoryIndex, writeManifest } from "../../src/memory/governance/index.js";

describe("MemoryCompactor", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-compactor-"));
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	function seed(rel: string, content: string): string {
		const full = path.join(dir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf-8");
		return full;
	}

	it("triggers deep compression for an oversized memory file", async () => {
		const manifest = defaultManifest();
		manifest.canonicalFiles.runtime = ".minimum/runtime.md";
		await writeManifest(dir, manifest);
		seed(
			".minimum/runtime.md",
			Array.from({ length: 80 }, (_, i) =>
				`<!-- mimo-memory source_session_id=s-${i} related_files=src/old.ts confidence=low last_verified=2025-01-01T00:00:00.000Z -->\n- stale fact ${i} ${"x".repeat(60)} confidence=low`,
			).join("\n"),
		);

		const report = await new MemoryCompactor(dir, {
			maxFileBytes: 512,
			now: new Date("2026-06-01T00:00:00.000Z"),
		}).compact();

		expect(report.deepCompressed).toBe(true);
		expect(report.decision.reasons.some((reason) => reason.startsWith("file_size:"))).toBe(true);
		expect(fs.existsSync(path.join(dir, ".minimum", "compressed.md"))).toBe(true);
		expect(report.archivedPaths).toHaveLength(1);
		expect(report.archivedPaths[0]).toContain(path.join("_archive", "2026-06"));
		const compressed = fs.readFileSync(path.join(dir, ".minimum", "compressed.md"), "utf-8");
		expect(compressed).toContain("source_session_id=s-0");
		expect(compressed).toContain("related_files=src/old.ts");
		expect(compressed).toContain("confidence=low");
		expect(compressed).toContain("last_verified=2025-01-01T00:00:00.000Z");
	});

	it("merges repeated bullets while preserving provenance", async () => {
		await writeManifest(dir, defaultManifest());
		seed(
			".minimum/project.md",
			`# Project

<!-- mimo-memory source_session_id=s-a related_files=src/a.ts confidence=medium last_verified=2025-01-01T00:00:00.000Z -->
- API: use the existing router for uploads
<!-- mimo-memory source_session_id=s-b related_files=src/b.ts confidence=high last_verified=2025-02-01T00:00:00.000Z -->
- API: use the existing router for uploads
<!-- mimo-memory source_session_id=s-c related_files=src/a.ts confidence=medium last_verified=2025-03-01T00:00:00.000Z -->
- use the existing router for uploads
`,
		);

		const report = await new MemoryCompactor(dir, { maxRecords: 99 }).compact();

		expect(report.lightMerged).toBe(2);
		const project = fs.readFileSync(path.join(dir, ".minimum", "project.md"), "utf-8");
		expect(project.match(/existing router for uploads/g)).toHaveLength(1);
		expect(project).toContain("source_session_id=s-a,s-b,s-c");
		expect(project).toContain("related_files=src/a.ts,src/b.ts");
		expect(project).toContain("confidence=high");
		expect(project).toContain("last_verified=2025-03-01T00:00:00.000Z");
	});

	it("merges within sections and preserves headings, not across sections (⑧)", async () => {
		await writeManifest(dir, defaultManifest());
		seed(
			".minimum/project.md",
			`# Frontend

<!-- mimo-memory source_session_id=s-a related_files=src/a.ts confidence=medium last_verified=2025-01-01T00:00:00.000Z -->
- Convention: keep validation in the route
<!-- mimo-memory source_session_id=s-b related_files=src/a.ts confidence=high last_verified=2025-02-01T00:00:00.000Z -->
- Convention: keep validation in the route

# Backend

<!-- mimo-memory source_session_id=s-c related_files=src/b.ts confidence=medium last_verified=2025-03-01T00:00:00.000Z -->
- Convention: keep validation in the route
`,
		);

		const report = await new MemoryCompactor(dir, { maxRecords: 99 }).compact();

		// Only the two Frontend duplicates merge; the Backend one is a separate section.
		expect(report.lightMerged).toBe(1);
		const project = fs.readFileSync(path.join(dir, ".minimum", "project.md"), "utf-8");
		expect(project).toContain("# Frontend");
		expect(project).toContain("# Backend");
		expect(project.match(/keep validation in the route/g)).toHaveLength(2);
	});

	it("clusters near-duplicate facts into representatives in compressed.md (⑦)", async () => {
		const manifest = defaultManifest();
		manifest.canonicalFiles.runtime = ".minimum/runtime.md";
		await writeManifest(dir, manifest);
		seed(
			".minimum/runtime.md",
			`<!-- mimo-memory source_session_id=s-1 related_files=src/api.ts confidence=high last_verified=2025-01-01T00:00:00.000Z -->
- API endpoint /upload returns 201
<!-- mimo-memory source_session_id=s-2 related_files=src/api.ts confidence=high last_verified=2025-01-02T00:00:00.000Z -->
- API endpoint /upload returns 201
<!-- mimo-memory source_session_id=s-3 related_files=src/api.ts confidence=high last_verified=2025-01-03T00:00:00.000Z -->
- API endpoint /upload returns 201
<!-- mimo-memory source_session_id=s-9 related_files=src/db.ts confidence=high last_verified=2025-01-04T00:00:00.000Z -->
- Database uses transactional migrations
`,
		);

		await new MemoryCompactor(dir, { maxRecords: 1, now: new Date("2026-06-01T00:00:00.000Z") }).compact();

		const compressed = fs.readFileSync(path.join(dir, ".minimum", "compressed.md"), "utf-8");
		// 4 source records collapse to 2 clusters (API ×3 → 1, Database → 1).
		expect(compressed.match(/<!-- mimo-memory/g)).toHaveLength(2);
		expect(compressed).toContain("API endpoint /upload returns 201");
		expect(compressed).toContain("Database uses transactional migrations");
	});

	it("skips files unchanged since the last compaction (⑩)", async () => {
		await writeManifest(dir, defaultManifest());
		seed(
			".minimum/project.md",
			`# Project

<!-- mimo-memory source_session_id=s-a related_files=src/a.ts confidence=medium last_verified=2025-01-01T00:00:00.000Z -->
- API: use the existing router
<!-- mimo-memory source_session_id=s-b related_files=src/a.ts confidence=high last_verified=2025-02-01T00:00:00.000Z -->
- API: use the existing router
`,
		);

		const first = await new MemoryCompactor(dir).compact();
		expect(first.lightMerged).toBe(1);
		// Second run: the file is unchanged since the watermark, so it is skipped.
		const second = await new MemoryCompactor(dir).compact();
		expect(second.lightMerged).toBe(0);
	});

	it("removes archived records from the refreshed index recall set", async () => {
		const manifest = defaultManifest();
		manifest.canonicalFiles.risks = ".minimum/risks.md";
		await writeManifest(dir, manifest);
		seed(
			".minimum/risks.md",
			`<!-- mimo-memory source_session_id=s-old related_files=src/risk.ts confidence=low last_verified=2024-01-01T00:00:00.000Z -->
- Deprecated low value risk note confidence=low
`,
		);

		await new MemoryCompactor(dir, {
			maxRecords: 1,
			now: new Date("2026-06-01T00:00:00.000Z"),
		}).compact();

		const index = await readMemoryIndex(dir);
		expect(index).not.toBeNull();
		expect(index!.entries.some((entry) => entry.path.includes("_archive/2026-06/risks.md"))).toBe(false);
		expect(index!.entries.find((entry) => entry.path === ".minimum/risks.md")?.exists).toBe(false);
		expect(index!.entries.find((entry) => entry.path === ".minimum/compressed.md")?.exists).toBe(true);
	});
});
