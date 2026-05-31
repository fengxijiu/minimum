import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyFinalize,
	buildMemoryIndex,
	defaultManifest,
	readMemoryIndex,
	refreshMemoryIndex,
	writeCandidate,
	writeManifest,
} from "../../src/memory/governance/index.js";
import { writeDag } from "../../src/orchestration/index.js";
import type { MemoryCandidate } from "../../src/memory/governance/index.js";

function mkCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
	return {
		sourceTask: "T-1",
		persona: "repo_scout",
		scope: "repo_map",
		confidence: "high",
		relatedFiles: ["src/a.ts"],
		body: "## Finding\nUse the existing router.",
		...overrides,
	};
}

describe("MemoryIndex", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-index-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	function seed(rel: string, content: string) {
		const full = path.join(dir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf-8");
	}

	it("indexes canonical headings, staging candidates, context packs, and artifacts", async () => {
		const manifest = defaultManifest();
		await writeManifest(dir, manifest);
		seed(".minimum/project.md", "# Project\n\n## Stack\nNode.");
		await writeCandidate(dir, mkCandidate());
		seed(".minimum/tasks/image_upload/context-packs/T2-1.md", "# Context Pack\n\n## Goal\nShip upload.");
		await writeDag(dir, "image_upload", { epicId: "image_upload", phases: [] });

		const index = await buildMemoryIndex(dir, manifest);

		const project = index.entries.find((entry) => entry.kind === "canonical" && entry.key === "project");
		expect(project?.headings).toContain("Stack");
		const staging = index.entries.find((entry) => entry.kind === "staging");
		expect(staging?.scope).toBe("repo_map");
		expect(staging?.relatedFiles).toEqual(["src/a.ts"]);
		expect(index.entries.some((entry) => entry.kind === "context_pack")).toBe(true);
		expect(index.entries.some((entry) => entry.kind === "pipeline_artifact" && entry.tags.includes("dag"))).toBe(true);
	});

	it("writes and reads .minimum/index.json", async () => {
		seed(".minimum/project.md", "## Project\nhi");
		const written = await refreshMemoryIndex(dir);
		expect(written).toBe(path.join(dir, ".minimum", "index.json"));
		const index = await readMemoryIndex(dir);
		expect(index).not.toBeNull();
		expect(index!.entries.length).toBeGreaterThan(0);
	});

	it("refreshes after W4 governance changes canonical and staging files", async () => {
		await writeCandidate(dir, mkCandidate({ sourceTask: "T-merge", persona: "code_executor" }));
		await applyFinalize(
			dir,
			{
				patchMergePlan: [],
				memoryDecisions: [
					{
						candidateId: "T-merge.code_executor",
						action: "merge",
						target: "architecture.md",
						section: "Upload",
						reason: "verified",
					},
				],
			},
			[mkCandidate({ sourceTask: "T-merge", persona: "code_executor" })],
			{ epicTaskIds: ["T-merge"] },
		);
		const index = await readMemoryIndex(dir);
		expect(index).not.toBeNull();
		expect(index!.entries.some((entry) => entry.path === ".minimum/architecture.md" && entry.exists)).toBe(true);
		expect(index!.entries.some((entry) => entry.kind === "staging" && entry.id === "T-merge.code_executor")).toBe(false);
	});
});
