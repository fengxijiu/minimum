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

/** Extract a one-line brief from a skill body for the brief catalog. */
function extractBriefFromBody(body: string, id: string): string {
	// First H2 heading that isn't a structural keyword
	const structural = /^(purpose|overview|when to use|inputs|outputs|rules|constraints|steps|workflow)/i;
	const h2 = body.match(/^##\s+(.+)$/m)?.[1]?.trim();
	if (h2 && h2.length < 80 && !structural.test(h2)) return h2;
	// First non-empty, non-heading, non-comment content line
	const firstLine = body.split("\n").find(
		(l) => l.trim() && !l.startsWith("#") && !l.startsWith("<!--"),
	);
	return firstLine?.trim().slice(0, 80) ?? id;
}

/**
 * Full inline skill bodies for a persona — always included in the system prompt
 * so the model can see and apply them on every turn.
 */
export function renderInlineSkillsForPersona(personaId: string): string {
	const matched = loadMinimumAdaptedSkills().filter((skill) => skill.personas.includes(personaId));
	if (!matched.length) return "";
	return [
		"# Minimum-native Superpowers Skills",
		...matched.map((skill) => `\n<!-- minimum-inline-skill:${skill.id} -->\n${skill.body}`),
	].join("\n");
}

/** Stage-scoped inline skills for prompts that should not carry the whole bundle. */
export function renderInlineSkillsForPersonaStage(personaId: string, stage: string): string {
	const matched = loadMinimumAdaptedSkills().filter(
		(skill) => skill.personas.includes(personaId) && skillAppliesToStage(skill, stage),
	);
	if (!matched.length) return "";
	return [
		"# Minimum-native Superpowers Skills",
		...matched.map((skill) => `\n<!-- minimum-inline-skill:${skill.id} -->\n${skill.body}`),
	].join("\n");
}

/**
 * Full bodies of inline skills that match the given objective.
 * Call once per task with the task's objective string;
 * returns "" when nothing matches so callers can skip it cheaply.
 */
export function renderInlineSkillsExpandedForPersona(personaId: string, objective: string): string {
	const matched = loadMinimumAdaptedSkills().filter((skill) => skill.personas.includes(personaId));
	if (!matched.length || !objective) return "";
	const objLower = objective.toLowerCase();
	const expanded = matched.filter((s) => {
		// Match on multi-char words from the skill id (e.g. "code-review" → ["code","review"])
		const idWords = s.id.split("-").filter((w) => w.length > 3);
		return idWords.some((w) => objLower.includes(w));
	});
	if (!expanded.length) return "";
	return [
		"## Active Inline Skills (matched to current task)",
		...expanded.map((s) => `\n<!-- minimum-inline-skill:${s.id} -->\n${s.body}`),
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
	if (file.includes("/base/")) return [
		"master_planner", "vision", "repo_scout", "context_builder",
		"code_executor", "test_writer", "test_runner", "runtime_debug", "reviewer", "docs",
	];
	if (file.includes("/review/")) return ["reviewer"];
	if (file.includes("/testing/")) return ["test_runner", "test_writer"];
	if (file.includes("/mission/")) return ["master_planner"];
	if (file.includes("/planning/") || file.includes("/dispatch/") || file.endsWith("_prompt-constraints.md")) return ["master_planner"];
	return ["master_planner"];
}

function stagesFor(file: string): string[] {
	if (file.includes("/base/")) return ["*"];
	if (file.includes("/review/")) return ["W3"];
	if (file.includes("/testing/")) return ["W2", "W3"];
	if (file.includes("/mission/")) return ["W3.5", "W4"];
	if (file.includes("/planning/") || file.includes("/dispatch/")) return ["W0", "W0.5", "W1"];
	return ["W0"];
}

function priorityFor(file: string): number {
	if (file.includes("/base/")) return 110;
	if (file.endsWith("_prompt-constraints.md")) return 100;
	if (file.includes("/planning/") || file.includes("/dispatch/")) return 90;
	if (file.includes("/mission/")) return 85;
	if (file.includes("/review/")) return 80;
	if (file.includes("/testing/")) return 80;
	return 50;
}

function skillAppliesToStage(skill: InlineSkill, stage: string): boolean {
	return skill.stages.includes("*") || skill.stages.includes(stage);
}
