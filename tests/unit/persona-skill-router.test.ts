import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assignSkillToPersona,
	writePersonaSkillRouting,
} from "../../src/skills/PersonaSkillRouter.js";

async function tmpRoot(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "minimum-router-"));
}

describe("PersonaSkillRouter", () => {
	it("assigns planning skills to master_planner with high confidence", async () => {
		const assignments = assignSkillToPersona({
			skillName: "subagent-task-assignment",
			description: "Use when decomposing implementation work into persona tasks.",
			body: "## Purpose\nPlanning and task decomposition.\n## When to Use\nUse when planning tasks.",
			source: "learn",
		});

		expect(assignments[0]).toMatchObject({
			persona_id: "master_planner",
			enabled: true,
			confidence: 0.9,
		});
		expect(assignments[0]?.stage_affinity).toContain("W1");
	});

	it("writes index and persona-skill-map files", async () => {
		const projectRoot = await tmpRoot();
		const assignments = assignSkillToPersona({
			skillName: "review-quality-check",
			description: "Use when reviewing code quality.",
			body: "## Purpose\nReview code.\n## When to Use\nUse when reviewing.",
			source: "learn",
		});

		await writePersonaSkillRouting({
			projectRoot,
			metadata: {
				skill_id: "review-quality-check",
				source: "learn",
				applies_to_personas: ["reviewer"],
				stage_affinity: ["W3"],
				routing: {
					mode: "auto",
					priority: 80,
					confidence: 0.92,
					requires_confirmation: false,
					conflict_policy: "prefer_more_specific_skill",
				},
				triggers: ["review"],
				capability_tags: ["review"],
			},
			assignments,
		});

		const index = await fs.readFile(path.join(projectRoot, ".minimum", "skills", "index.json"), "utf-8");
		const map = await fs.readFile(path.join(projectRoot, ".minimum", "skills", "persona-skill-map.json"), "utf-8");
		expect(index).toContain("review-quality-check");
		expect(map).toContain("reviewer");
	});
});
