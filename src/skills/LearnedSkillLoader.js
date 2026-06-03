import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getString, getStringArray, parseSkillMarkdown } from "./SkillMarkdown.js";
export async function loadLearnedSkills(projectRoot) {
    const base = path.join(projectRoot, ".minimum", "skills", "learned");
    try {
        const entries = await fs.readdir(base, { withFileTypes: true });
        const skills = [];
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const skillPath = path.join(base, entry.name, "SKILL.md");
            try {
                const markdown = await fs.readFile(skillPath, "utf-8");
                const parsed = parseSkillMarkdown(markdown);
                const name = getString(parsed.frontmatter.skill_id, entry.name);
                const status = getString(parsed.frontmatter.status, "active");
                if (status === "disabled")
                    continue;
                skills.push({
                    name,
                    description: firstDescription(parsed.body, name),
                    tags: getStringArray(parsed.frontmatter.capability_tags),
                    triggers: getStringArray(parsed.frontmatter.triggers),
                    capability_tags: getStringArray(parsed.frontmatter.capability_tags),
                    status,
                    prompt: parsed.body.trim(),
                    path: skillPath,
                    metadata: parsed.frontmatter,
                });
            }
            catch {
                // Ignore malformed learned skill directories so one bad skill does not break /skill list.
            }
        }
        return skills.sort((a, b) => a.name.localeCompare(b.name));
    }
    catch {
        return [];
    }
}
export function loadLearnedSkillsSync(projectRoot) {
    const base = path.join(projectRoot, ".minimum", "skills", "learned");
    try {
        return fsSync.readdirSync(base, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .flatMap((entry) => {
            const skillPath = path.join(base, entry.name, "SKILL.md");
            try {
                const markdown = fsSync.readFileSync(skillPath, "utf-8");
                const parsed = parseSkillMarkdown(markdown);
                const name = getString(parsed.frontmatter.skill_id, entry.name);
                const status = getString(parsed.frontmatter.status, "active");
                if (status === "disabled")
                    return [];
                return [{
                        name,
                        description: firstDescription(parsed.body, name),
                        tags: getStringArray(parsed.frontmatter.capability_tags),
                        triggers: getStringArray(parsed.frontmatter.triggers),
                        capability_tags: getStringArray(parsed.frontmatter.capability_tags),
                        status,
                        prompt: parsed.body.trim(),
                        path: skillPath,
                        metadata: parsed.frontmatter,
                    }];
            }
            catch {
                return [];
            }
        })
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    catch {
        return [];
    }
}
function firstDescription(body, name) {
    const when = body.match(/^##\s+When to Use\s*$(.*?)(?:^##\s+|$)/ims)?.[1]?.trim();
    if (when)
        return when.split(/\r?\n/).find((line) => line.trim())?.replace(/^[-*]\s*/, "").trim() ?? name;
    return `Use when running learned skill ${name}.`;
}
