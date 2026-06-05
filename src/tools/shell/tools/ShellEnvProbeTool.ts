import { ShellCategoryTool, type ShellCategoryToolOptions } from "./ShellCategoryTool.js";

export class ShellEnvProbeTool extends ShellCategoryTool {
	constructor(opts: Omit<ShellCategoryToolOptions, "name" | "description" | "allowedCategories">) {
		super({
			...opts,
			name: "shell_env_probe",
			description: "Probe installed tool versions: node, npm, python, cargo, go, rustc, deno, bun.",
			allowedCategories: ["env_probe"],
		});
	}
}
