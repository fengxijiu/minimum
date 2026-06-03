import { toSkillSlug } from "./LearnedSkillName.js";
export function renderLearnedSkillMarkdown(draft, routing) {
    const skillId = toSkillSlug(draft.name);
    const tags = draft.tags ?? [];
    const triggers = routing?.triggers ?? draft.triggers ?? [draft.description];
    const capabilityTags = routing?.capability_tags ?? draft.capability_tags ?? tags;
    const appliesToPersonas = routing?.applies_to_personas ?? ["master_planner"];
    const stageAffinity = routing?.stage_affinity ?? ["W1"];
    const body = draft.body.trim();
    return `---
skill_id: ${skillId}
skill_type: learned
version: 1.0.0
source: learn
status: ${draft.status === "applied" ? "active" : "draft"}
applies_to_personas:
${renderList(appliesToPersonas)}
stage_affinity:
${renderList(stageAffinity)}
routing:
  mode: ${routing?.routing.mode ?? "auto"}
  priority: ${routing?.routing.priority ?? 80}
  confidence: ${(routing?.routing.confidence ?? 0.9).toFixed(2)}
  requires_confirmation: ${routing?.routing.requires_confirmation ?? false}
  conflict_policy: ${routing?.routing.conflict_policy ?? "prefer_more_specific_skill"}
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
function renderList(values) {
    return values.map((value) => `  - ${JSON.stringify(value)}`).join("\n");
}
