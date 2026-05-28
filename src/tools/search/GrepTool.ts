import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
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

		const grepArgs: string[] = ["-rn"];
		if (args.ignoreCase) grepArgs[0] += "i";

		if (args.include) {
			grepArgs.push(`--include=${args.include}`);
		}

		grepArgs.push("--", args.pattern, args.path || ".");

		try {
			const { stdout } = await execFileAsync("grep", grepArgs, {
				cwd,
				timeout: 10000,
			});
			const lines = stdout.split("\n");
			const max = args.maxResults || 50;
			return lines.length > max
				? lines.slice(0, max).join("\n") + `\n... (${lines.length - max} more results)`
				: stdout || "No matches found";
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
				const { stdout } = await execFileAsync("find", [
					".",
					"-name",
					`*${args.query}*`,
					"-type",
					"f",
				], { cwd, timeout: 10000 });
				const lines = stdout.split("\n").filter(Boolean).slice(0, 20);
				if (lines.length) {
					results.push("Files:");
					results.push(lines.join("\n"));
				}
			} catch {
				// Ignore errors
			}
		}

		if (args.type === "content" || args.type === "both") {
			try {
				const { stdout } = await execFileAsync("grep", [
					"-rn",
					"--include=*.ts",
					"--include=*.js",
					"--include=*.py",
					"--",
					args.query,
					".",
				], { cwd, timeout: 10000 });
				const lines = stdout.split("\n").filter(Boolean).slice(0, 20);
				if (lines.length) {
					results.push("\nContent:");
					results.push(lines.join("\n"));
				}
			} catch {
				// Ignore errors
			}
		}

		return results.join("\n") || "No results found";
	}
}
