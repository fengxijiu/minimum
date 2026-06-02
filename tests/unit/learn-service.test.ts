import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LearnCommandService } from "../../src/learn/LearnCommandService.js";
import { validateLearnedSkillDraft } from "../../src/learn/LearnedSkillValidator.js";
import { loadProjectSkillPrompt } from "../../src/personas/PersonaSkillMap.js";
import { loadLearnedSkills } from "../../src/skills/LearnedSkillLoader.js";

const goodBody = `# Pipeline Loop Check

## Purpose
Capture acceptance-loop decisions for future pipeline tasks.

## When to Use
Use when a session reveals reusable acceptance-loop rules.

## Inputs
- Current conversation context.

## Core Workflow
1. Extract stable rules.
2. Ignore one-off details.

## Output Contract
Return a reusable skill document.

## Rules and Constraints
- Do not modify personas.

## Verification Checklist
- Skill has clear triggers.

## Failure Modes
- Reject noisy context.
`;

async function tmpRoot(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "minimum-learn-"));
}

describe("learn service", () => {
	it("validates learned skill drafts with required sections", () => {
		const result = validateLearnedSkillDraft({
			name: "pipeline-loop-check",
			description: "Use when checking pipeline loop acceptance.",
			body: goodBody,
			tags: ["pipeline"],
		});
		expect(result.ok).toBe(true);
	});

	it("rejects descriptions that do not start with Use when", () => {
		const result = validateLearnedSkillDraft({
			name: "bad-skill",
			description: "Checks pipeline loop acceptance.",
			body: goodBody,
		});
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("Use when"))).toBe(true);
	});

	it("creates, previews, applies, and loads a learned skill", async () => {
		const projectRoot = await tmpRoot();
		const service = new LearnCommandService({
			projectRoot,
			generateWithModel: async () => JSON.stringify({
				name: "pipeline-loop-check",
				description: "Use when checking pipeline loop acceptance.",
				body: goodBody,
				tags: ["pipeline"],
			}),
		});

		const created = await service.create({
			preferredName: "pipeline-loop-check",
			messages: [{ role: "user", content: "remember this acceptance loop" }],
		});

		expect(created.draft.name).toBe("pipeline-loop-check");
		const preview = await service.preview(created.draft.id);
		expect(preview.markdown).toContain("# Pipeline Loop Check");

		const applied = await service.apply(created.draft.id);
		expect(applied.skillPath.endsWith("SKILL.md")).toBe(true);
		expect(applied.assignments[0]?.persona_id).toBe("master_planner");

		const loaded = await loadLearnedSkills(projectRoot);
		expect(loaded.map((s) => s.name)).toContain("pipeline-loop-check");
		const runtimePrompt = await loadProjectSkillPrompt({
			projectRoot,
			personaId: "master_planner",
			stage: "W1",
		});
		expect(runtimePrompt).toContain("Pipeline Loop Check");
	});
});
