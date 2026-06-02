import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { LearnMessage } from "./types.js";

export interface LearnSkillWriterInput {
	conversationSummary: string;
	recentMessages: LearnMessage[];
	preferredName?: string;
	projectRoot: string;
	existingSkillNames: string[];
}

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_SKILL_PATH = path.resolve(
	SRC_DIR,
	"..",
	"skills",
	"system",
	"learn-skill-writer",
	"SKILL.md",
);

export class LearnSkillPromptLoader {
	async load(): Promise<string> {
		return await fs.readFile(SYSTEM_SKILL_PATH, "utf-8");
	}

	async buildPrompt(input: LearnSkillWriterInput): Promise<string> {
		const skill = await this.load();
		return `${skill.trim()}

## Runtime Input

Return ONLY a JSON object with: name, description, body, tags, triggers, capability_tags.

${JSON.stringify(input, null, 2)}
`;
	}
}
