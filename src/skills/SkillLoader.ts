import * as path from "path";
import * as fs from "fs/promises";
import { Skill } from "./Skill.js";
import type { SkillContext, SkillMetadata, SkillResult } from "./Skill.js";
import type { SkillRegistry } from "./SkillRegistry.js";

export interface SkillFile {
	metadata: SkillMetadata;
	execute: (context: SkillContext) => Promise<SkillResult>;
}

export class SkillLoader {
	private registry: SkillRegistry;

	constructor(registry: SkillRegistry) {
		this.registry = registry;
	}

	async loadFromDirectory(dirPath: string): Promise<number> {
		let loaded = 0;

		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true });

			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith(".skill.js")) {
					const filePath = path.join(dirPath, entry.name);
					const success = await this.loadFromFile(filePath);
					if (success) loaded++;
				}
			}
		} catch {
			// Directory might not exist
		}

		return loaded;
	}

	async loadFromFile(filePath: string): Promise<boolean> {
		try {
			const content = await fs.readFile(filePath, "utf-8");

			// Parse skill file (simplified - would need proper module loading)
			const skillData = JSON.parse(content);

			if (skillData.metadata && skillData.execute) {
				const skill = new DynamicSkill(skillData.metadata, skillData.execute);
				this.registry.register(skill);
				return true;
			}

			return false;
		} catch {
			return false;
		}
	}

	async loadFromConfig(configPath: string): Promise<number> {
		try {
			const content = await fs.readFile(configPath, "utf-8");
			const config = JSON.parse(content);

			let loaded = 0;

			for (const skillPath of config.skills || []) {
				const success = await this.loadFromFile(skillPath);
				if (success) loaded++;
			}

			return loaded;
		} catch {
			return 0;
		}
	}
}

class DynamicSkill extends Skill {
	metadata: SkillMetadata;
	private executeFn: (context: SkillContext) => Promise<SkillResult>;

	constructor(
		metadata: SkillMetadata,
		executeFn: (context: SkillContext) => Promise<SkillResult>,
	) {
		super();
		this.metadata = metadata;
		this.executeFn = executeFn;
	}

	async execute(context: SkillContext): Promise<SkillResult> {
		return this.executeFn(context);
	}
}
