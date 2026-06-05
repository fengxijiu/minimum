import { ShellCategoryTool, type ShellCategoryToolOptions } from "./ShellCategoryTool.js";

export class ShellTypecheckTool extends ShellCategoryTool {
	constructor(opts: Omit<ShellCategoryToolOptions, "name" | "description" | "allowedCategories">) {
		super({
			...opts,
			name: "shell_typecheck",
			description: "Run typecheck/static diagnostics commands such as tsc --noEmit, mypy, cargo check, go vet.",
			allowedCategories: ["typecheck"],
		});
	}
}
