import { ShellCategoryTool, type ShellCategoryToolOptions } from "./ShellCategoryTool.js";

export class ShellTestTool extends ShellCategoryTool {
	constructor(opts: Omit<ShellCategoryToolOptions, "name" | "description" | "allowedCategories">) {
		super({
			...opts,
			name: "shell_test",
			description: "Run approved test commands such as npm test, vitest, jest, pytest, cargo test, go test.",
			allowedCategories: ["test"],
		});
	}
}
