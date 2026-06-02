import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SkillRoutingMetadata } from "../skills/PersonaSkillRouter.js";
import type { LearnedSkillDraft } from "./types.js";
import { atomicWriteJson } from "./LearnDraftStore.js";
import { renderLearnedSkillMarkdown } from "./LearnedSkillRenderer.js";
import { toSkillSlug } from "./LearnedSkillName.js";

export interface LearnedSkillWriterResult {
	skillPath: string;
	metadataPath: string;
	markdown: string;
}

export class LearnedSkillWriter {
	constructor(private readonly projectRoot: string) {}

	async write(
		draft: LearnedSkillDraft,
		routing?: SkillRoutingMetadata,
		options: { allowExisting?: boolean } = {},
	): Promise<LearnedSkillWriterResult> {
		const slug = toSkillSlug(draft.name);
		const dir = path.join(this.projectRoot, ".minimum", "skills", "learned", slug);
		const skillPath = path.join(dir, "SKILL.md");
		const metadataPath = path.join(dir, "metadata.json");

		if (await exists(skillPath)) {
			if (options.allowExisting) {
				const markdown = await fs.readFile(skillPath, "utf-8");
				return { skillPath, metadataPath, markdown };
			}
			throw new Error(`learned skill already exists: ${slug}`);
		}

		const appliedDraft: LearnedSkillDraft = {
			...draft,
			status: "applied",
			updatedAt: new Date().toISOString(),
			targetDir: dir,
			targetPath: skillPath,
		};
		const markdown = renderLearnedSkillMarkdown(appliedDraft, routing);

		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(skillPath, markdown, "utf-8");
		await atomicWriteJson(metadataPath, {
			name: slug,
			description: appliedDraft.description,
			status: "active",
			source: "learn",
			tags: appliedDraft.tags ?? [],
			triggers: appliedDraft.triggers ?? [appliedDraft.description],
			capability_tags: appliedDraft.capability_tags ?? [],
			createdAt: appliedDraft.createdAt,
			updatedAt: appliedDraft.updatedAt,
		});

		return { skillPath, metadataPath, markdown };
	}
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
