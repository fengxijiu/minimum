import type { LearnedSkillDraft } from "./types.js";
import { toSkillSlug } from "./LearnedSkillName.js";

export function renderLearnedSkillMarkdown(draft: LearnedSkillDraft): string {
	const skillId = toSkillSlug(draft.name);
	const tags = draft.tags ?? [];
	const triggers = draft.triggers ?? [draft.description];
	const capabilityTags = draft.capability_tags ?? tags;
	const body = draft.body.trim();

	return `---
skill_id: ${skillId}
skill_type: learned
version: 1.0.0
source: learn
status: ${draft.status === "applied" ? "active" : "draft"}
applies_to_personas:
  - master_planner
stage_affinity:
  - W1
routing:
  mode: auto
  priority: 80
  confidence: 0.90
  requires_confirmation: false
  conflict_policy: prefer_more_specific_skill
triggers:
${renderList(triggers)}
capability_tags:
${renderList(capabilityTags.length ? capabilityTags : ["context_learning"])}
safety:
  can_modify_code: false
  can_modify_persona: false
  can_modify_workflow: false
  can_write_skill: true
---

${body}
`;
}

function renderList(values: string[]): string {
	return values.map((value) => `  - ${JSON.stringify(value)}`).join("\n");
}
