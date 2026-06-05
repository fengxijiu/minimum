import { ShellCategoryTool, type ShellCategoryToolOptions } from "./ShellCategoryTool.js";

export class ShellGitReadTool extends ShellCategoryTool {
	constructor(opts: Omit<ShellCategoryToolOptions, "name" | "description" | "allowedCategories">) {
		super({
			...opts,
			name: "shell_git_read",
			description: "Run read-only git commands: status, diff, log, show, blame, branch read, remote read.",
			allowedCategories: ["git_read"],
		});
	}
}
