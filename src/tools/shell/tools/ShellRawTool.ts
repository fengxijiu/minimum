import { ShellCategoryTool, type ShellCategoryToolOptions } from "./ShellCategoryTool.js";

export class ShellRawTool extends ShellCategoryTool {
	constructor(opts: Omit<ShellCategoryToolOptions, "name" | "description" | "allowedCategories" | "rawEnabled">) {
		super({
			...opts,
			name: "shell_raw",
			description: "Run arbitrary shell-like commands through the safe runner. Requires approval.",
			allowedCategories: ["raw"],
			rawEnabled: true,
		});
	}
}
