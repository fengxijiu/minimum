import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteJson } from "../learn/LearnDraftStore.js";
export function assignSkillToPersona(input) {
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
function routingText(input) {
    const sanitizedBody = input.body
        .split(/\r?\n/)
        .filter((line) => !isRoutingBoilerplate(line))
        .join("\n");
    return `${input.skillName} ${input.description} ${sanitizedBody}`.toLowerCase();
}
function isRoutingBoilerplate(line) {
    return /^\s*#+\s+/.test(line)
        || /do not modify personas?/i.test(line)
        || /do not write (project memory directly|\.minimum\/memory)/i.test(line)
        || /can_modify_persona:\s*(true|false)/i.test(line);
}
export function buildRoutingMetadata(draft, assignments) {
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
export async function writePersonaSkillRouting(input) {
    const skillsDir = path.join(input.projectRoot, ".minimum", "skills");
    const indexPath = path.join(skillsDir, "index.json");
    const mapPath = path.join(skillsDir, "persona-skill-map.json");
    const index = await readJson(indexPath, { skills: {} });
    const map = await readJson(mapPath, { personas: {} });
    const skills = asRecord(index.skills);
    skills[input.metadata.skill_id] = input.metadata;
    index.skills = skills;
    const personas = asRecord(map.personas);
    for (const assignment of input.assignments) {
        const existing = asRecord(personas[assignment.persona_id]);
        const list = Array.isArray(existing.skills) ? existing.skills : [];
        const withoutDuplicate = list.filter((item) => item?.skill_id !== assignment.skill_id);
        withoutDuplicate.push(assignment);
        existing.skills = withoutDuplicate;
        personas[assignment.persona_id] = existing;
    }
    map.personas = personas;
    await atomicWriteJson(indexPath, index);
    await atomicWriteJson(mapPath, map);
}
function inferRoute(text) {
    if (matches(text, ["planning", "decompos", "task", "dispatch", "contract", "persona", "loop", "acceptance"])) {
        return { persona: "master_planner", stages: ["W1", "W3.5"], priority: 90, confidence: 0.9, reason: "planning and dispatch capability maps to master_planner" };
    }
    if (matches(text, ["review", "audit", "quality", "severity", "spec compliance"])) {
        return { persona: "reviewer", stages: ["W3"], priority: 85, confidence: 0.92, reason: "review capability maps to reviewer W3" };
    }
    if (matches(text, ["test", "verification", "red", "green", "runner", "evidence"])) {
        return { persona: "test_runner", stages: ["W3"], priority: 82, confidence: 0.9, reason: "testing evidence capability maps to test_runner" };
    }
    if (matches(text, ["documentation", "docs", "readme", "changelog"])) {
        return { persona: "docs", stages: ["W4"], priority: 78, confidence: 0.88, reason: "documentation capability maps to docs persona" };
    }
    if (matches(text, ["code", "implement", "refactor", "patch"])) {
        return { persona: "code_executor", stages: ["W2"], priority: 75, confidence: 0.84, reason: "implementation capability maps to code_executor" };
    }
    return { persona: "master_planner", stages: ["W1"], priority: 50, confidence: 0.55, reason: "fallback stage-level route requires confirmation" };
}
function matches(text, needles) {
    return needles.some((needle) => text.includes(needle));
}
function unique(values) {
    return Array.from(new Set(values));
}
async function readJson(filePath, fallback) {
    try {
        return JSON.parse(await fs.readFile(filePath, "utf-8"));
    }
    catch {
        return fallback;
    }
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
