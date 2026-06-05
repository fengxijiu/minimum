import { ShellCategoryTool, type ShellCategoryToolOptions } from "./ShellCategoryTool.js";

export class ShellSearchTool extends ShellCategoryTool {
	constructor(opts: Omit<ShellCategoryToolOptions, "name" | "description" | "allowedCategories">) {
		super({
			...opts,
			name: "shell_search",
			description: "Run safe repository search commands: grep, rg, read-only find.",
			allowedCategories: ["search"],
		});
	}
}
