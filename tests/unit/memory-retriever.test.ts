import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryRetriever } from "../../src/memory/single/index.js";
import type { MemoryIndex } from "../../src/memory/governance/index.js";

function writeFile(root: string, rel: string, content: string, mtime = Date.now()): void {
	const full = path.join(root, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf-8");
	fs.utimesSync(full, mtime / 1000, mtime / 1000);
}

function writeIndex(root: string, memoryRoot: string, index: MemoryIndex): void {
	writeFile(root, path.join(memoryRoot, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
}

function makeIndex(root: string, memoryRoot: string, entries: MemoryIndex["entries"]): MemoryIndex {
	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		memoryRoot,
		entries: entries.map((entry) => {
			const stat = fs.statSync(path.join(root, entry.path));
			return { ...entry, exists: true, bytes: stat.size, mtimeMs: stat.mtimeMs };
		}),
	};
}

describe("MemoryRetriever", () => {
	let projectRoot: string;
	let home: string;
	let globalRoot: string;

	beforeEach(() => {
		projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-retriever-project-"));
		home = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-retriever-home-"));
		globalRoot = path.join(home, ".minimum");
	});

	afterEach(() => {
		fs.rmSync(projectRoot, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("recalls project memory when a recently mentioned file path matches relatedFiles", async () => {
		writeFile(projectRoot, ".minimum/frontend.md", "# Frontend\n\n## Upload Form\nKeep upload validation in the route component.");
		writeFile(globalRoot, "preferences.md", "# Preferences\n\nPrefer concise diffs.");
		writeIndex(
			projectRoot,
			".minimum",
			makeIndex(projectRoot, ".minimum", [
				{
					kind: "canonical",
					key: "frontend",
					path: ".minimum/frontend.md",
					exists: true,
					bytes: 0,
					mtimeMs: 0,
					headings: ["Frontend", "Upload Form"],
					tags: ["canonical", "frontend"],
					relatedFiles: ["src/routes/upload.tsx"],
				},
			]),
		);
		writeIndex(
			path.dirname(globalRoot),
			".minimum",
			makeIndex(path.dirname(globalRoot), ".minimum", [
				{
					kind: "canonical",
					key: "preferences",
					path: ".minimum/preferences.md",
					exists: true,
					bytes: 0,
					mtimeMs: 0,
					headings: ["Preferences"],
					tags: ["canonical", "preferences"],
					relatedFiles: [],
				},
			]),
		);

		const result = await new MemoryRetriever({ projectRoot, globalMemoryRoot: globalRoot }).retrieveMemory({
			input: "What should I change here?",
			messages: [{ role: "user", content: "I'm editing src/routes/upload.tsx today." }],
		});

		expect(result.entries[0]?.layer).toBe("project");
		expect(result.entries[0]?.entry.key).toBe("frontend");
		expect(result.prelude).toContain("Upload Form");
	});

	it("recalls global memory for broad preference questions", async () => {
		writeFile(globalRoot, "preferences.md", "# Preferences\n\n## Style\nPrefer small focused patches and Vitest for checks.");
		writeIndex(
			path.dirname(globalRoot),
			".minimum",
			makeIndex(path.dirname(globalRoot), ".minimum", [
				{
					kind: "canonical",
					key: "preferences",
					path: ".minimum/preferences.md",
					exists: true,
					bytes: 0,
					mtimeMs: 0,
					headings: ["Preferences", "Style"],
					tags: ["canonical", "preferences", "style"],
					scope: "user_preferences",
					relatedFiles: [],
				},
			]),
		);

		const result = await new MemoryRetriever({ projectRoot, globalMemoryRoot: globalRoot }).retrieveMemory(
			"What are my preferences for code style?",
		);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.layer).toBe("global");
		expect(result.prelude).toContain("Prefer small focused patches");
	});

	it("excerpts only the matched section, not the whole file (④)", async () => {
		writeFile(
			projectRoot,
			".minimum/notes.md",
			"# Notes\n\n## Alpha topic\nAlpha details about the alpha thing.\n\n## Beta topic\nBeta details about beta.",
		);
		writeIndex(
			projectRoot,
			".minimum",
			makeIndex(projectRoot, ".minimum", [
				{
					kind: "canonical",
					key: "notes",
					path: ".minimum/notes.md",
					exists: true,
					bytes: 0,
					mtimeMs: 0,
					headings: ["Notes", "Alpha topic", "Beta topic"],
					tags: ["canonical", "notes"],
					relatedFiles: [],
				},
			]),
		);

		const result = await new MemoryRetriever({ projectRoot, globalMemoryRoot: globalRoot }).retrieveMemory(
			"alpha",
		);

		expect(result.entries).toHaveLength(1);
		expect(result.prelude).toContain("Alpha details");
		expect(result.prelude).not.toContain("Beta details");
	});

	it("guarantees each layer at least one slot under the quota (⑤)", async () => {
		// Three project entries outrank the single global entry, but perLayerMin
		// reserves a global slot so the hierarchy is represented.
		for (const key of ["one", "two", "three"]) {
			writeFile(projectRoot, `.minimum/${key}.md`, `# ${key}\n\n## Topic\nalpha note for ${key}.`);
		}
		writeFile(globalRoot, "prefs.md", "# Prefs\n\n## Topic\nalpha global preference.");
		writeIndex(
			projectRoot,
			".minimum",
			makeIndex(projectRoot, ".minimum", ["one", "two", "three"].map((key) => ({
				kind: "canonical" as const,
				key,
				path: `.minimum/${key}.md`,
				exists: true,
				bytes: 0,
				mtimeMs: 0,
				headings: [key, "Topic"],
				tags: ["canonical", key, "alpha"],
				relatedFiles: [],
			}))),
		);
		writeIndex(
			path.dirname(globalRoot),
			".minimum",
			makeIndex(path.dirname(globalRoot), ".minimum", [
				{
					kind: "canonical",
					key: "prefs",
					path: ".minimum/prefs.md",
					exists: true,
					bytes: 0,
					mtimeMs: 0,
					headings: ["Prefs", "Topic"],
					tags: ["canonical", "prefs", "alpha"],
					relatedFiles: [],
				},
			]),
		);

		const result = await new MemoryRetriever({
			projectRoot,
			globalMemoryRoot: globalRoot,
			maxResults: 2,
			perLayerMin: 1,
		}).retrieveMemory("alpha");

		expect(result.entries).toHaveLength(2);
		expect(result.entries.some((e) => e.layer === "global")).toBe(true);
		expect(result.entries.some((e) => e.layer === "project")).toBe(true);
	});

	it("caps the prelude by the token budget (④)", async () => {
		writeFile(projectRoot, ".minimum/a.md", "# A\n\n## Topic\nalpha note A.");
		writeFile(projectRoot, ".minimum/b.md", "# B\n\n## Topic\nalpha note B.");
		writeIndex(
			projectRoot,
			".minimum",
			makeIndex(projectRoot, ".minimum", ["a", "b"].map((key) => ({
				kind: "canonical" as const,
				key,
				path: `.minimum/${key}.md`,
				exists: true,
				bytes: 0,
				mtimeMs: 0,
				headings: [key, "Topic"],
				tags: ["canonical", key, "alpha"],
				relatedFiles: [],
			}))),
		);

		const result = await new MemoryRetriever({
			projectRoot,
			globalMemoryRoot: globalRoot,
			maxTokens: 1,
		}).retrieveMemory("alpha");

		// Both match, but the 1-token budget keeps only the first (always kept).
		expect(result.entries).toHaveLength(1);
	});

	it("does not include unrelated memories in the prelude", async () => {
		writeFile(projectRoot, ".minimum/backend.md", "# Backend\n\n## Database\nUse transactional migrations.");
		writeIndex(
			projectRoot,
			".minimum",
			makeIndex(projectRoot, ".minimum", [
				{
					kind: "canonical",
					key: "backend",
					path: ".minimum/backend.md",
					exists: true,
					bytes: 0,
					mtimeMs: 0,
					headings: ["Backend", "Database"],
					tags: ["canonical", "backend", "database"],
					relatedFiles: ["src/db/schema.ts"],
				},
			]),
		);

		const result = await new MemoryRetriever({ projectRoot, globalMemoryRoot: globalRoot }).retrieveMemory(
			"How should the button animation look?",
		);

		expect(result.entries).toEqual([]);
		expect(result.prelude).toBe("");
	});
});
