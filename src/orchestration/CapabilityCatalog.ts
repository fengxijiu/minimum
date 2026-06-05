import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TaskContract } from "./TaskContract.js";

/**
 * CapabilityCatalog — the pool of skills + MCP tools the master_planner may
 * grant to a task at W0.5. Personas do not carry these by default; the master
 * hands them out per task ("invisible pool"). The catalog is rendered into the
 * refine prompt so the master knows what it may grant, and `validateGrants`
 * rejects grants that reference capabilities outside the catalog.
 */

export interface GrantableSkill {
	id: string;
	brief: string;
	triggers: string[];
}
export interface GrantableMcpTool {
	name: string;
	description: string;
}
export interface GrantableCatalog {
	skills: GrantableSkill[];
	mcpTools: GrantableMcpTool[];
}

export interface BuildCatalogInput {
	projectRoot: string;
	/** Connected MCP tools as {name: "mcp__server__tool", description}. */
	mcpTools: GrantableMcpTool[];
	denylistSkills: string[];
	denylistMcpTools: string[];
}

/** Enumerate learned skills + connected MCP tools, minus the configured denylists. */
export async function buildGrantableCatalog(input: BuildCatalogInput): Promise<GrantableCatalog> {
	const deniedSkills = new Set(input.denylistSkills);
	const deniedTools = new Set(input.denylistMcpTools);

	const learnedDir = path.join(input.projectRoot, ".minimum", "skills", "learned");
	const index = await readIndex(input.projectRoot);
	let ids: string[] = [];
	try {
		ids = (await fs.readdir(learnedDir, { withFileTypes: true }))
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		ids = [];
	}

	const skills: GrantableSkill[] = [];
	for (const id of ids.sort()) {
		if (deniedSkills.has(id)) continue;
		skills.push({ id, brief: await readBrief(learnedDir, id), triggers: index[id]?.triggers ?? [] });
	}

	const mcpTools = input.mcpTools
		.filter((t) => !deniedTools.has(t.name))
		.sort((a, b) => a.name.localeCompare(b.name));

	return { skills, mcpTools };
}

/** Markdown section for the master's W0.5 input describing what it may grant. */
export function renderGrantableCatalog(catalog: GrantableCatalog): string {
	const skillLines = catalog.skills.length
		? catalog.skills.map(
				(s) => `- ${s.id}: ${s.brief}${s.triggers.length ? `  _(triggers: ${s.triggers.slice(0, 3).join(", ")})_` : ""}`,
			)
		: ["(none)"];
	const toolLines = catalog.mcpTools.length
		? catalog.mcpTools.map((t) => `- ${t.name}: ${t.description}`)
		: ["(none)"];
	return [
		"# Grantable Capabilities (skills + MCP)",
		"",
		"Grant a task the MINIMUM extra capability it needs via grantedSkills / grantedMcpTools. Default to none.",
		"",
		"## Grantable Skills",
		...skillLines,
		"",
		"## Grantable MCP Tools",
		...toolLines,
	].join("\n");
}

/** Errors for grants that reference capabilities absent from the catalog. */
export function validateGrants(contract: TaskContract, catalog: GrantableCatalog): string[] {
	const errors: string[] = [];
	const skillIds = new Set(catalog.skills.map((s) => s.id));
	const toolNames = new Set(catalog.mcpTools.map((t) => t.name));
	for (const id of contract.grantedSkills ?? []) {
		if (!skillIds.has(id))
			errors.push(`task ${contract.taskId}: grantedSkill "${id}" is not in the grantable catalog (unknown or denied)`);
	}
	for (const name of contract.grantedMcpTools ?? []) {
		if (!toolNames.has(name))
			errors.push(`task ${contract.taskId}: grantedMcpTool "${name}" is not in the grantable catalog (unknown or denied)`);
	}
	return errors;
}

async function readBrief(learnedDir: string, id: string): Promise<string> {
	try {
		const raw = await fs.readFile(path.join(learnedDir, id, "SKILL.md"), "utf-8");
		const body = raw.replace(/^---[\s\S]*?\n---\s*/, "").trim();
		const firstBullet = body.split(/\r?\n/).find((l) => l.trim().startsWith("-"));
		if (firstBullet) return firstBullet.replace(/^[-*]\s*/, "").trim().slice(0, 80);
		const firstLine = body.split("\n").find((l) => l.trim() && !l.startsWith("#"));
		return (firstLine ?? id).trim().slice(0, 80);
	} catch {
		return id;
	}
}

async function readIndex(projectRoot: string): Promise<Record<string, { triggers?: string[] }>> {
	try {
		const raw = await fs.readFile(path.join(projectRoot, ".minimum", "skills", "index.json"), "utf-8");
		const parsed = JSON.parse(raw) as { skills?: Record<string, { triggers?: string[] }> };
		return parsed.skills ?? {};
	} catch {
		return {};
	}
}
