import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export class GitTool {
	name = "git";
	description = "Execute git commands";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					subcommand: {
						type: "string",
						description:
							"Git subcommand (status, diff, log, add, commit, push, pull, etc.)",
					},
					args: {
						type: "string",
						description: "Additional arguments",
					},
				},
				required: ["subcommand"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string },
	): Promise<string> {
		const cwd = context?.workingDirectory || process.cwd();
		const command = `git ${args.subcommand} ${args.args || ""}`.trim();

		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd,
				timeout: 30000,
			});

			let result = "";
			if (stdout) result += stdout;
			if (stderr) result += `\n${stderr}`;

			return result || "Git command executed successfully";
		} catch (error: any) {
			return `Git command failed: ${error.message}\n${error.stderr || ""}`;
		}
	}
}

export class GitStatusTool {
	name = "git_status";
	description = "Get git status";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					porcelain: {
						type: "boolean",
						description: "Use porcelain format",
						default: false,
					},
				},
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string },
	): Promise<string> {
		const cwd = context?.workingDirectory || process.cwd();
		const command = args.porcelain ? "git status --porcelain" : "git status";

		try {
			const { stdout } = await execAsync(command, { cwd });
			return stdout || "No changes";
		} catch (error: any) {
			return `Error: ${error.message}`;
		}
	}
}

export class GitDiffTool {
	name = "git_diff";
	description = "Show git diff";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					staged: {
						type: "boolean",
						description: "Show staged changes",
						default: false,
					},
					file: {
						type: "string",
						description: "Specific file to diff",
					},
				},
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string },
	): Promise<string> {
		const cwd = context?.workingDirectory || process.cwd();
		let command = "git diff";

		if (args.staged) command += " --staged";
		if (args.file) command += ` ${args.file}`;

		try {
			const { stdout } = await execAsync(command, { cwd });
			return stdout || "No differences";
		} catch (error: any) {
			return `Error: ${error.message}`;
		}
	}
}

export class GitLogTool {
	name = "git_log";
	description = "Show git log";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					limit: {
						type: "number",
						description: "Number of commits to show",
						default: 10,
					},
					oneline: {
						type: "boolean",
						description: "Use oneline format",
						default: true,
					},
				},
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string },
	): Promise<string> {
		const cwd = context?.workingDirectory || process.cwd();
		const limit = args.limit || 10;
		const format = args.oneline ? "--oneline" : "";
		const command = `git log ${format} -${limit}`;

		try {
			const { stdout } = await execAsync(command, { cwd });
			return stdout || "No commits";
		} catch (error: any) {
			return `Error: ${error.message}`;
		}
	}
}
