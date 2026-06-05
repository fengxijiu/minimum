import { ShellCategoryTool, type ShellCategoryToolOptions } from "./ShellCategoryTool.js";

export class ShellLintTool extends ShellCategoryTool {
	constructor(opts: Omit<ShellCategoryToolOptions, "name" | "description" | "allowedCategories">) {
		super({
			...opts,
			name: "shell_lint",
			description: "Run non-mutating lint/format-check commands. Auto-fix/write flags are denied.",
			allowedCategories: ["lint"],
		});
	}
}
