import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	defaultManifest,
	loadCanonicalMemory,
	resolveLoadKeys,
	writeManifest,
} from "../../src/memory/governance/index.js";

describe("resolveLoadKeys", () => {
	const m = defaultManifest();

	it("includes always-keys for any task type", () => {
		const keys = resolveLoadKeys(m, "debugging");
		expect(keys).toContain("project");
		expect(keys).toContain("architecture");
	});

	it("appends frontend-specific keys for frontend", () => {
		const keys = resolveLoadKeys(m, "frontend");
		expect(keys).toContain("visual");
		expect(keys).toContain("frontend");
	});

	it("appends backend-specific keys for backend", () => {
		const keys = resolveLoadKeys(m, "backend");
		expect(keys).toContain("backend");
		expect(keys).toContain("api");
	});

	it("appends both for mixed", () => {
		const keys = resolveLoadKeys(m, "mixed");
		expect(keys).toContain("visual");
		expect(keys).toContain("api");
	});

	it("deduplicates across always + extra", () => {
		// debugging policy includes "tests" which is also in always
		const keys = resolveLoadKeys(m, "debugging");
		expect(keys.filter((k) => k === "tests")).toHaveLength(1);
	});

	it("preserves order: always first, then extras", () => {
		const keys = resolveLoadKeys(m, "frontend");
		expect(keys[0]).toBe("project");
		expect(keys.indexOf("visual")).toBeGreaterThan(keys.indexOf("tests"));
	});
});

describe("loadCanonicalMemory", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-loader-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	function seed(file: string, content: string) {
		const full = path.join(dir, ".minimum", file);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	}

	it("returns empty-ish prefix when no canonical files exist", async () => {
		const r = await loadCanonicalMemory(dir, "frontend");
		expect(r.includedKeys).toEqual([]);
		expect(r.text).toContain("# Canonical Project Memory");
	});

	it("includes existing files for the task type", async () => {
		seed("project.md", "## Stack\n- Vite + React\n");
		seed("frontend.md", "## Frontend\nuse Tailwind\n");
		seed("backend.md", "## Backend\nFastAPI\n");
		const r = await loadCanonicalMemory(dir, "frontend");
		expect(r.includedKeys).toContain("project");
		expect(r.includedKeys).toContain("frontend");
		expect(r.includedKeys).not.toContain("backend");
		expect(r.text).toContain("Vite + React");
		expect(r.text).toContain("Tailwind");
	});

	it("respects maxTokens cap and reports truncation", async () => {
		const big = "x".repeat(5000); // ~1250 tokens at 4 chars/token
		seed("project.md", big);
		seed("architecture.md", big);
		seed("repo-map.md", big);
		const r = await loadCanonicalMemory(dir, "frontend", { maxTokens: 1500 });
		expect(r.truncated).toBe(true);
		expect(r.includedKeys.length).toBeLessThan(3);
	});

	it("skips missing files without crashing", async () => {
		seed("project.md", "## P\nhi\n");
		// architecture.md absent
		const r = await loadCanonicalMemory(dir, "frontend");
		expect(r.includedKeys).toContain("project");
		expect(r.includedKeys).not.toContain("architecture");
	});

	it("uses a custom manifest passed in opts", async () => {
		const m = defaultManifest();
		m.canonicalFiles.custom = ".minimum/custom.md";
		m.loadPolicy.always = ["custom"];
		await writeManifest(dir, m);
		seed("custom.md", "## Custom\nrules\n");
		const r = await loadCanonicalMemory(dir, "frontend", { manifest: m });
		expect(r.includedKeys).toEqual(["custom"]);
		expect(r.text).toContain("rules");
	});
});
