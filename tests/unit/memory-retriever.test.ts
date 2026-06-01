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
