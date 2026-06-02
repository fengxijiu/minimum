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

const ambiguousBody = `# Ambiguous Skill

## Purpose
Capture a reusable but weakly-scoped workflow hint.

## When to Use
Use when the session leaves a reusable but weakly-scoped workflow hint.

## Inputs
- Current conversation context.

## Core Workflow
1. Extract the stable rule.
2. Ignore one-off details.

## Output Contract
Return concise reusable guidance.

## Rules and Constraints
- Do not modify personas.

## Verification Checklist
- The trigger matches the current context.

## Failure Modes
- Skip if the hint is too noisy.
`;

const reviewBody = `# Review Quality Check

## Purpose
Capture a reusable review checklist for code quality work.

## When to Use
Use when reviewing code quality and compliance issues.

## Inputs
- Diff under review.

## Core Workflow
1. Inspect the changed code.
2. Call out defects and review findings.

## Output Contract
Return concise review findings.

## Rules and Constraints
- Do not modify personas.

## Verification Checklist
- Findings are grounded in the diff.

## Failure Modes
- Skip if there is no review target.
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
		expect(applied.routingWritten).toBe(true);

		const loaded = await loadLearnedSkills(projectRoot);
		expect(loaded.map((s) => s.name)).toContain("pipeline-loop-check");
		const runtimePrompt = await loadProjectSkillPrompt({
			projectRoot,
			personaId: "master_planner",
			stage: "W1",
		});
		expect(runtimePrompt).toContain("Pipeline Loop Check");
	});

	it("requires explicit confirmation before writing low-confidence persona routing", async () => {
		const projectRoot = await tmpRoot();
		const service = new LearnCommandService({
			projectRoot,
			generateWithModel: async () => JSON.stringify({
				name: "ambiguous-skill",
				description: "Use when the session leaves a reusable but ambiguous workflow hint.",
				body: ambiguousBody,
				tags: ["ambiguous"],
			}),
		});

		const created = await service.create({
			preferredName: "ambiguous-skill",
			messages: [{ role: "user", content: "remember an ambiguous reusable hint" }],
		});

		const applied = await service.apply(created.draft.id);
		expect(applied.routingConfirmationRequired).toBe(true);
		expect(applied.routingWritten).toBe(false);
		expect(applied.routing.routing.requires_confirmation).toBe(true);

		const runtimePromptBeforeConfirm = await loadProjectSkillPrompt({
			projectRoot,
			personaId: "master_planner",
			stage: "W1",
		});
		expect(runtimePromptBeforeConfirm).toBe("");

		const confirmed = await service.apply(created.draft.id, { confirmRouting: true });
		expect(confirmed.routingWritten).toBe(true);

		const runtimePromptAfterConfirm = await loadProjectSkillPrompt({
			projectRoot,
			personaId: "master_planner",
			stage: "W1",
		});
		expect(runtimePromptAfterConfirm).toContain("Ambiguous Skill");
	});

	it("writes learned skill frontmatter from routing metadata", async () => {
		const projectRoot = await tmpRoot();
		const service = new LearnCommandService({
			projectRoot,
			generateWithModel: async () => JSON.stringify({
				name: "review-quality-check",
				description: "Use when reviewing code quality and spec compliance.",
				body: reviewBody,
				tags: ["review"],
			}),
		});

		const created = await service.create({
			preferredName: "review-quality-check",
			messages: [{ role: "user", content: "remember this review checklist" }],
		});

		const applied = await service.apply(created.draft.id);
		const markdown = await fs.readFile(applied.skillPath, "utf-8");
		expect(markdown).toContain("skill_id: review-quality-check");
		expect(markdown).toContain('"reviewer"');
		expect(markdown).toContain('"W3"');
		expect(markdown).toContain("requires_confirmation: false");
	});
});
