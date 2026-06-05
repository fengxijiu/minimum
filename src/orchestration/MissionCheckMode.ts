export type MissionCheckMode = "skip" | "light" | "full";

export function decideMissionCheckMode(ctx: {
	hasFileChanges: boolean;
	isReadOnlyTask: boolean;
	changedFiles: string[];
	testsPassed: boolean;
	userRequestedFullCheck: boolean;
}): MissionCheckMode {
	if (!ctx.hasFileChanges) return "skip";
	if (ctx.isReadOnlyTask) return "skip";
	if (ctx.userRequestedFullCheck) return "full";
	if (ctx.changedFiles.every(isDocOrPromptFile)) return "light";
	if (ctx.changedFiles.length <= 1 && ctx.testsPassed) return "light";
	return "full";
}

function isDocOrPromptFile(path: string): boolean {
	return /\.(md|txt|rst|adoc)$/.test(path) ||
		path.includes("prompts/") ||
		path.includes("docs/");
}
