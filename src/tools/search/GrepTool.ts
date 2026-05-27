import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export class GrepTool {
	name = "grep";
	description = "Search for patterns in files";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					pattern: {
						type: "string",
						description: "Search pattern (regex)",
					},
					path: {
						type: "string",
						description: "File or directory to search",
					},
					include: {
						type: "string",
						description: 'File pattern to include (e.g., "*.ts")',
					},
					ignoreCase: {
						type: "boolean",
						description: "Case insensitive search",
						default: false,
					},
					maxResults: {
						type: "number",
						description: "Maximum number of results",
						default: 50,
					},
				},
				required: ["pattern"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string },
	): Promise<string> {
		const cwd = context?.workingDirectory || process.cwd();

		let command = "grep -r";

		if (args.ignoreCase) command += "i";
		command += "n";

		if (args.include) {
			command += ` --include="${args.include}"`;
		}

		command += ` "${args.pattern}"`;
		command += ` ${args.path || "."}`;

		if (args.maxResults) {
			command += ` | head -${args.maxResults}`;
		}

		try {
			const { stdout } = await execAsync(command, { cwd, timeout: 10000 });
			return stdout || "No matches found";
		} catch (error: any) {
			if (error.code === 1) {
				return "No matches found";
			}
			return `Error: ${error.message}`;
		}
	}
}

export class SearchTool {
	name = "search";
	description = "Search for files and content";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Search query",
					},
					type: {
						type: "string",
						enum: ["files", "content", "both"],
						description: "What to search for",
						default: "both",
					},
				},
				required: ["query"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string },
	): Promise<string> {
		const cwd = context?.workingDirectory || process.cwd();
		const results: string[] = [];

		if (args.type === "files" || args.type === "both") {
			try {
				const { stdout } = await execAsync(
					`find . -name "*${args.query}*" -type f | head -20`,
					{ cwd },
				);
				if (stdout) {
					results.push("Files:");
					results.push(stdout);
				}
			} catch {
				// Ignore errors
			}
		}

		if (args.type === "content" || args.type === "both") {
			try {
				const { stdout } = await execAsync(
					`grep -r "${args.query}" --include="*.ts" --include="*.js" --include="*.py" . | head -20`,
					{ cwd },
				);
				if (stdout) {
					results.push("\nContent:");
					results.push(stdout);
				}
			} catch {
				// Ignore errors
			}
		}

		return results.join("\n") || "No results found";
	}
}
