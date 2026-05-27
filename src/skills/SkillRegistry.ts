import type { Skill } from "./Skill.js";
import type { SkillContext, SkillMetadata, SkillResult } from "./Skill.js";

export class SkillRegistry {
	private skills: Map<string, Skill> = new Map();

	register(skill: Skill): void {
		this.skills.set(skill.getName(), skill);
	}

	unregister(name: string): boolean {
		return this.skills.delete(name);
	}

	get(name: string): Skill | undefined {
		return this.skills.get(name);
	}

	list(): SkillMetadata[] {
		return Array.from(this.skills.values()).map((skill) => skill.metadata);
	}

	has(name: string): boolean {
		return this.skills.has(name);
	}

	async execute(name: string, context: SkillContext): Promise<SkillResult> {
		const skill = this.skills.get(name);

		if (!skill) {
			return {
				success: false,
				output: "",
				error: `Skill not found: ${name}`,
			};
		}

		try {
			return await skill.execute(context);
		} catch (error: any) {
			return {
				success: false,
				output: "",
				error: `Skill execution failed: ${error.message}`,
			};
		}
	}
}
