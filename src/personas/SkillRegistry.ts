import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface InlineSkill {
	id: string;
	body: string;
	personas: string[];
	stages: string[];
	priority: number;
}

const ADAPTED_ROOT = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"inline-skills",
	"minimum-adapted",
);

export function loadMinimumAdaptedSkills(): InlineSkill[] {
	const skills: InlineSkill[] = [];
	for (const file of walkMarkdown(ADAPTED_ROOT)) {
		const id = path.basename(file, ".md");
		const rel = file.replace(/\\/g, "/");
		skills.push({
			id,
			body: fs.readFileSync(file, "utf-8").trim(),
			personas: personasFor(rel),
			stages: stagesFor(rel),
			priority: priorityFor(rel),
		});
	}
	return skills.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

export function renderInlineSkillsForPersona(personaId: string): string {
	const matched = loadMinimumAdaptedSkills().filter((skill) => skill.personas.includes(personaId));
	if (!matched.length) return "";
	return [
		"# Minimum-native Superpowers Skills",
		...matched.map((skill) => `\n<!-- minimum-inline-skill:${skill.id} -->\n${skill.body}`),
	].join("\n");
}

function walkMarkdown(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkMarkdown(full));
		else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
	}
	return out;
}

function personasFor(file: string): string[] {
	if (file.includes("/review/")) return ["reviewer"];
	if (file.includes("/testing/")) return ["test_runner", "test_writer"];
	if (file.includes("/mission/")) return ["master_planner"];
	if (file.includes("/planning/") || file.includes("/dispatch/") || file.endsWith("_prompt-constraints.md")) return ["master_planner"];
	return ["master_planner"];
}

function stagesFor(file: string): string[] {
	if (file.includes("/review/")) return ["W3"];
	if (file.includes("/testing/")) return ["W2", "W3"];
	if (file.includes("/mission/")) return ["W3.5", "W4"];
	if (file.includes("/planning/") || file.includes("/dispatch/")) return ["W0", "W0.5", "W1"];
	return ["W0"];
}

function priorityFor(file: string): number {
	if (file.endsWith("_prompt-constraints.md")) return 100;
	if (file.includes("/planning/") || file.includes("/dispatch/")) return 90;
	if (file.includes("/mission/")) return 85;
	if (file.includes("/review/")) return 80;
	if (file.includes("/testing/")) return 80;
	return 50;
}
