import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteJson } from "../learn/LearnDraftStore.js";
import type { LearnedSkillDraft } from "../learn/types.js";

export type SkillSource = "learn" | "skill_install" | "manual" | "system";

export interface SkillRoutingMetadata {
	skill_id: string;
	source: SkillSource;
	applies_to_personas: string[];
	stage_affinity: string[];
	routing: {
		mode: "auto" | "manual";
		priority: number;
		confidence: number;
		requires_confirmation: boolean;
		conflict_policy:
			| "prefer_more_specific_skill"
			| "prefer_higher_priority"
			| "load_both";
	};
	triggers: string[];
	capability_tags: string[];
}

export interface PersonaSkillAssignment {
	persona_id: string;
	skill_id: string;
	stage_affinity: string[];
	priority: number;
	enabled: boolean;
	reason: string;
	confidence: number;
}

export interface AssignSkillInput {
	skillName: string;
	description: string;
	body: string;
	source: SkillSource;
}

export function assignSkillToPersona(input: AssignSkillInput): PersonaSkillAssignment[] {
	const text = routingText(input);
	const inferred = inferRoute(text);
	return [{
		persona_id: inferred.persona,
		skill_id: input.skillName,
		stage_affinity: inferred.stages,
		priority: inferred.priority,
		enabled: inferred.confidence >= 0.7,
		reason: inferred.reason,
		confidence: inferred.confidence,
	}];
}

function routingText(input: AssignSkillInput): string {
	const sanitizedBody = input.body
		.split(/\r?\n/)
		.filter((line) => !isRoutingBoilerplate(line))
		.join("\n");
	return `${input.skillName} ${input.description} ${sanitizedBody}`.toLowerCase();
}

function isRoutingBoilerplate(line: string): boolean {
	return /^\s*#+\s+/.test(line)
		|| /do not modify personas?/i.test(line)
		|| /do not write (project memory directly|\.minimum\/memory)/i.test(line)
		|| /can_modify_persona:\s*(true|false)/i.test(line);
}

export function buildRoutingMetadata(
	draft: Pick<LearnedSkillDraft, "name" | "description" | "tags" | "triggers" | "capability_tags">,
	assignments: PersonaSkillAssignment[],
): SkillRoutingMetadata {
	const primary = assignments[0];
	const confidence = primary?.confidence ?? 0.5;
	return {
		skill_id: draft.name,
		source: "learn",
		applies_to_personas: assignments.map((a) => a.persona_id),
		stage_affinity: unique(assignments.flatMap((a) => a.stage_affinity)),
		routing: {
			mode: "auto",
			priority: primary?.priority ?? 50,
			confidence,
			requires_confirmation: confidence < 0.9,
			conflict_policy: "prefer_more_specific_skill",
		},
		triggers: draft.triggers?.length ? draft.triggers : [draft.description],
		capability_tags: draft.capability_tags?.length ? draft.capability_tags : draft.tags ?? [],
	};
}

export async function writePersonaSkillRouting(input: {
	projectRoot: string;
	metadata: SkillRoutingMetadata;
	assignments: PersonaSkillAssignment[];
}): Promise<void> {
	const skillsDir = path.join(input.projectRoot, ".minimum", "skills");
	const indexPath = path.join(skillsDir, "index.json");
	const mapPath = path.join(skillsDir, "persona-skill-map.json");
	const index = await readJson<Record<string, unknown>>(indexPath, { skills: {} });
	const map = await readJson<Record<string, any>>(mapPath, { personas: {} });

	const skills = asRecord(index.skills);
	skills[input.metadata.skill_id] = input.metadata;
	index.skills = skills;

	const personas = asRecord(map.personas);
	for (const assignment of input.assignments) {
		const existing = asRecord(personas[assignment.persona_id]);
		const list = Array.isArray(existing.skills) ? existing.skills as unknown[] : [];
		const withoutDuplicate = list.filter((item: any) => item?.skill_id !== assignment.skill_id);
		withoutDuplicate.push(assignment);
		existing.skills = withoutDuplicate;
		personas[assignment.persona_id] = existing;
	}
	map.personas = personas;

	await atomicWriteJson(indexPath, index);
	await atomicWriteJson(mapPath, map);
}

const PERSONA_ROUTES = [
	{
		persona: "master_planner", stages: ["W1", "W3.5"], priority: 90,
		keywords: [
			"planning", "decompos", "dispatch", "contract", "persona", "acceptance",
			"milestone", "roadmap", "sprint", "prioriti", "orchestrat", "workflow",
			"coordinat", "delegat", "kickoff", "breakdown", "subtask", "dependency",
			"timeline", "objective", "goal", "strategy", "scope", "requirem",
		],
		reason: "planning and dispatch capability maps to master_planner",
	},
	{
		persona: "reviewer", stages: ["W3"], priority: 85,
		keywords: [
			"review", "audit", "quality", "severity", "spec compliance",
			"lint", "static analysis", "code smell", "best practice", "convention",
			"standard", "guideline", "checklist", "inspect", "evaluat", "assess",
			"feedback", "critiqu", "suggest", "improve", "issue", "violation",
		],
		reason: "review capability maps to reviewer W3",
	},
	{
		persona: "test_runner", stages: ["W3"], priority: 82,
		keywords: [
			"test", "verification", "evidence", "assert", "expect",
			"mock", "stub", "fixture", "coverage", "unit", "integration",
			"e2e", "end-to-end", "regression", "ci", "tdd", "bdd",
			"passing", "failing", "suite", "spec", "vitest", "jest", "pytest",
		],
		reason: "testing evidence capability maps to test_runner",
	},
	{
		persona: "docs", stages: ["W4"], priority: 78,
		keywords: [
			"documentation", "docs", "readme", "changelog",
			"docstring", "jsdoc", "typedoc", "comment", "explain", "describ",
			"annotat", "wiki", "guide", "tutorial", "example", "usage",
			"api doc", "reference", "glossary", "faq",
		],
		reason: "documentation capability maps to docs persona",
	},
	{
		persona: "code_executor", stages: ["W2"], priority: 75,
		keywords: [
			"code", "implement", "refactor", "patch", "fix", "bug",
			"feature", "function", "class", "module", "component", "algorithm",
			"logic", "build", "compil", "debug", "exception", "optimiz",
			"performance", "sql", "query", "script", "format", "typing",
			"parse", "transform", "render", "hook", "api", "endpoint",
		],
		reason: "implementation capability maps to code_executor",
	},
] as const;

function inferRoute(text: string): {
	persona: string;
	stages: string[];
	priority: number;
	confidence: number;
	reason: string;
} {
	let bestScore = 0;
	let bestRoute: typeof PERSONA_ROUTES[number] | null = null;

	for (const route of PERSONA_ROUTES) {
		const score = route.keywords.filter((kw) => text.includes(kw)).length;
		if (score > bestScore) {
			bestScore = score;
			bestRoute = route;
		}
	}

	if (bestScore === 0 || bestRoute === null) {
		return { persona: "master_planner", stages: ["W1"], priority: 50, confidence: 0.55, reason: "fallback: no keywords matched, requires confirmation" };
	}

	// Scale confidence with match depth: 1 keyword → 0.90, 3 → 0.94, 5+ → 0.96
	const confidence = Math.min(0.96, 0.90 + Math.min(bestScore - 1, 4) * 0.015);
	return {
		persona: bestRoute.persona,
		stages: [...bestRoute.stages],
		priority: bestRoute.priority,
		confidence,
		reason: bestRoute.reason,
	};
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values));
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
	} catch {
		return fallback;
	}
}

function asRecord(value: unknown): Record<string, any> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, any>
		: {};
}
