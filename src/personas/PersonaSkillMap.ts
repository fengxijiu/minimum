import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PersonaId } from "./Persona.js";

export interface RuntimePersonaSkill {
	skill_id: string;
	priority: number;
	enabled: boolean;
	stage_affinity: string[];
	confidence: number;
}

export async function loadPersonaSkillMap(projectRoot: string): Promise<Record<string, RuntimePersonaSkill[]>> {
	const file = path.join(projectRoot, ".minimum", "skills", "persona-skill-map.json");
	try {
		const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as any;
		const out: Record<string, RuntimePersonaSkill[]> = {};
		for (const [persona, value] of Object.entries(parsed.personas ?? {})) {
			const skills = Array.isArray((value as any).skills) ? (value as any).skills : [];
			out[persona] = skills.filter((skill: any) => skill?.enabled !== false);
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Two-tier project skill prompt for a persona turn:
 *   Tier 1 (catalog)  — always included: one-line brief per skill so the model knows what exists.
 *   Tier 2 (expanded) — full body only for skills whose triggers/capability_tags appear in the objective.
 */
export async function loadProjectSkillPrompt(input: {
	projectRoot: string;
	personaId: PersonaId;
	stage?: string;
	objective?: string;
}): Promise<string> {
	const map = await loadPersonaSkillMap(input.projectRoot);
	const skills = (map[input.personaId] ?? [])
		.filter((skill) => skill.enabled)
		.filter((skill) =>
			!input.stage ||
			input.stage.startsWith("P") ||
			skill.stage_affinity.length === 0 ||
			skill.stage_affinity.includes(input.stage),
		)
		.sort((a, b) => b.priority - a.priority || b.confidence - a.confidence);

	if (!skills.length) return "";

	const index = await readSkillsIndex(input.projectRoot);
	const objLower = (input.objective ?? "").toLowerCase();

	// When no objective is given (e.g. planner finalize, refine, or test callers),
	// fall back to full expansion for all matched skills to preserve pre-two-tier behaviour.
	if (!objLower) {
		const bodies: string[] = [];
		for (const skill of skills) {
			const body = await readLearnedSkillBody(input.projectRoot, skill.skill_id);
			if (body) bodies.push(`<!-- project-persona-skill:${skill.skill_id} -->\n${body}`);
		}
		return bodies.length ? `# Project Routed Skills\n\n${bodies.join("\n\n")}` : "";
	}

	// Tier 1: brief catalog — always included when objective is present
	const catalogLines: string[] = [];
	for (const skill of skills) {
		const meta = index[skill.skill_id];
		const triggers = meta?.triggers?.slice(0, 3).join(", ") ?? "";
		const brief = await readLearnedSkillBrief(input.projectRoot, skill.skill_id);
		catalogLines.push(`- **${skill.skill_id}**: ${brief}${triggers ? `  _(triggers: ${triggers})_` : ""}`);
	}

	// Tier 2: full expansion for objective-matched skills
	const expanded: string[] = [];
	for (const skill of skills) {
		const meta = index[skill.skill_id];
		const triggers: string[] = meta?.triggers ?? [];
		const capTags: string[] = meta?.capability_tags ?? [];
		const matched =
			triggers.some((t) => objLower.includes(t.toLowerCase())) ||
			capTags.some((t) => objLower.includes(t.toLowerCase())) ||
			objLower.includes(skill.skill_id.toLowerCase());
		if (matched) {
			const body = await readLearnedSkillBody(input.projectRoot, skill.skill_id);
			if (body) expanded.push(`<!-- project-persona-skill:${skill.skill_id} -->\n${body}`);
		}
	}

	const parts = [
		"# Project Routed Skills",
		"",
		"Available project skills (full guidance auto-loads when objective matches):",
		...catalogLines,
	];
	if (expanded.length) {
		parts.push("", "## Active Project Skills (matched to objective)", "", expanded.join("\n\n"));
	}
	return parts.join("\n");
}

async function readLearnedSkillBrief(projectRoot: string, skillId: string): Promise<string> {
	const file = path.join(projectRoot, ".minimum", "skills", "learned", skillId, "SKILL.md");
	try {
		const raw = await fs.readFile(file, "utf-8");
		const body = raw.replace(/^---[\s\S]*?\n---\s*/, "").trim();
		const whenMatch = body.match(/^##\s+When to Use\s*$(.*?)(?:^##\s+|$)/ims)?.[1]?.trim();
		if (whenMatch) {
			const first = whenMatch.split(/\r?\n/).find((l) => l.trim())?.replace(/^[-*]\s*/, "").trim();
			if (first) return first.slice(0, 80);
		}
		const firstLine = body.split("\n").find((l) => l.trim() && !l.startsWith("#"));
		return firstLine?.trim().slice(0, 80) ?? skillId;
	} catch {
		return skillId;
	}
}

async function readLearnedSkillBody(projectRoot: string, skillId: string): Promise<string> {
	const file = path.join(projectRoot, ".minimum", "skills", "learned", skillId, "SKILL.md");
	try {
		const raw = await fs.readFile(file, "utf-8");
		return raw.replace(/^---[\s\S]*?\n---\s*/, "").trim();
	} catch {
		return "";
	}
}

async function readSkillsIndex(projectRoot: string): Promise<Record<string, { triggers?: string[]; capability_tags?: string[] }>> {
	const file = path.join(projectRoot, ".minimum", "skills", "index.json");
	try {
		const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as { skills?: Record<string, unknown> };
		return (parsed.skills ?? {}) as Record<string, { triggers?: string[]; capability_tags?: string[] }>;
	} catch {
		return {};
	}
}
