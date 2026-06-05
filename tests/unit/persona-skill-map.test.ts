import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGrantedSkillPrompt } from "../../src/personas/PersonaSkillMap.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-map-"));
	const learned = path.join(dir, ".minimum", "skills", "learned", "pdf-extract");
	fs.mkdirSync(learned, { recursive: true });
	fs.writeFileSync(
		path.join(learned, "SKILL.md"),
		"---\nid: pdf-extract\n---\n## When to Use\n- Extract text from PDFs\n\nUse pdfplumber.\n",
	);
	// Deliberately NO persona-skill-map.json — granted skills bypass the map.
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("loadGrantedSkillPrompt", () => {
	it("loads granted skill bodies regardless of the persona-skill-map", async () => {
		const out = await loadGrantedSkillPrompt(dir, ["pdf-extract"]);
		expect(out).toContain("Granted Skills");
		expect(out).toContain("granted-skill:pdf-extract");
		expect(out).toContain("Use pdfplumber.");
	});

	it("returns empty string when nothing is granted", async () => {
		expect(await loadGrantedSkillPrompt(dir, [])).toBe("");
	});

	it("skips a granted id with no skill body", async () => {
		expect(await loadGrantedSkillPrompt(dir, ["does-not-exist"])).toBe("");
	});
});
