import { ShellCategoryTool, type ShellCategoryToolOptions } from "./ShellCategoryTool.js";

export class ShellFsReadTool extends ShellCategoryTool {
	constructor(opts: Omit<ShellCategoryToolOptions, "name" | "description" | "allowedCategories">) {
		super({
			...opts,
			name: "shell_fs_read",
			description: "Run read-only filesystem inspection commands: pwd, ls, cat, head, tail, wc, file, tree.",
			allowedCategories: ["fs_read"],
		});
	}
}
