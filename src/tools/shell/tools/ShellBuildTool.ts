import { ShellCategoryTool, type ShellCategoryToolOptions } from "./ShellCategoryTool.js";

export class ShellBuildTool extends ShellCategoryTool {
	constructor(opts: Omit<ShellCategoryToolOptions, "name" | "description" | "allowedCategories">) {
		super({
			...opts,
			name: "shell_build",
			description: "Run build/static compile commands such as npm run build, cargo build, go build.",
			allowedCategories: ["build"],
		});
	}
}
