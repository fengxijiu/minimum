export interface SkillMetadata {
	name: string;
	description: string;
	version?: string;
	author?: string;
	tags?: string[];
}

export interface SkillContext {
	workingDirectory: string;
	projectRoot: string;
	variables: Record<string, any>;
}

export interface SkillResult {
	success: boolean;
	output: string;
	error?: string;
}

export abstract class Skill {
	abstract metadata: SkillMetadata;

	abstract execute(context: SkillContext): Promise<SkillResult>;

	getName(): string {
		return this.metadata.name;
	}

	getDescription(): string {
		return this.metadata.description;
	}
}
