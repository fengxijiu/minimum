import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { LearnCommandService } from "../../src/learn/LearnCommandService.js";
import { validateLearnedSkillDraft } from "../../src/learn/LearnedSkillValidator.js";
import { loadProjectSkillPrompt } from "../../src/personas/PersonaSkillMap.js";

const body = `# Ambiguous Skill

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

async function tmpRoot(): Promise<string> {
	return await fs.mkdtemp(path.join(os.tmpdir(), "minimum-integrated-learn-"));
}

describe("integrated learn + persona superpowers pressure scenarios", () => {
	it("low-confidence routing does not silently inject persona prompt before confirmation", async () => {
		const projectRoot = await tmpRoot();
		const service = new LearnCommandService({
			projectRoot,
			generateWithModel: async () =>
				JSON.stringify({
					name: "ambiguous-skill",
					description: "Use when the session leaves a reusable but weakly-scoped workflow hint.",
					body,
				}),
		});

		const created = await service.create({
			preferredName: "ambiguous-skill",
			messages: [{ role: "user", content: "remember this vague but reusable workflow" }],
		});
		const applied = await service.apply(created.draft.id);
		expect(applied.routingConfirmationRequired).toBe(true);
		expect(applied.routingWritten).toBe(false);

		const promptBeforeConfirm = await loadProjectSkillPrompt({
			projectRoot,
			personaId: "master_planner",
			stage: "W1",
		});
		expect(promptBeforeConfirm).toBe("");

		const confirmed = await service.apply(created.draft.id, { confirmRouting: true });
		expect(confirmed.routingWritten).toBe(true);

		const promptAfterConfirm = await loadProjectSkillPrompt({
			projectRoot,
			personaId: "master_planner",
			stage: "W1",
		});
		expect(promptAfterConfirm).toContain("Ambiguous Skill");
	});

	it("learned skill validator blocks persona and memory modification attempts", () => {
		const result = validateLearnedSkillDraft({
			name: "unsafe-skill",
			description: "Use when applying an unsafe skill.",
			body: `${body}

can_modify_persona: true
.minimum/memory`,
		});
		expect(result.ok).toBe(false);
		expect(result.errors).toContain("learned skills cannot modify personas");
		expect(result.errors).toContain("learned skills cannot write .minimum/memory");
	});
});
