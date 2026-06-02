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

export async function loadProjectSkillPrompt(input: {
	projectRoot: string;
	personaId: PersonaId;
	stage?: string;
	objective?: string;
}): Promise<string> {
	const map = await loadPersonaSkillMap(input.projectRoot);
	const skills = (map[input.personaId] ?? [])
		.filter((skill) => skill.enabled)
		.filter((skill) => !input.stage || input.stage.startsWith("P") || skill.stage_affinity.length === 0 || skill.stage_affinity.includes(input.stage))
		.sort((a, b) => b.priority - a.priority || b.confidence - a.confidence);
	const bodies: string[] = [];
	for (const skill of skills) {
		const body = await readLearnedSkillBody(input.projectRoot, skill.skill_id);
		if (body) bodies.push(`<!-- project-persona-skill:${skill.skill_id} -->\n${body}`);
	}
	return bodies.length ? `# Project Routed Skills\n\n${bodies.join("\n\n")}` : "";
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
