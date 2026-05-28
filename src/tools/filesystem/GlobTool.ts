import * as fs from "node:fs/promises";
import * as path from "node:path";

export class GlobTool {
	name = "glob";
	description = "Find files matching a glob pattern";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					pattern: {
						type: "string",
						description: "Glob pattern to match",
					},
					cwd: {
						type: "string",
						description: "Working directory (default: current directory)",
					},
					ignore: {
						type: "array",
						items: { type: "string" },
						description: "Patterns to ignore",
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
		const cwd = args.cwd || context?.workingDirectory || process.cwd();

		try {
			const pattern = args.pattern;
			const files = await this.glob(pattern, cwd, args.ignore || []);
			return files.join("\n");
		} catch (error: any) {
			return `Error executing glob: ${error.message}`;
		}
	}

	private async glob(
		pattern: string,
		cwd: string,
		ignore: string[],
	): Promise<string[]> {
		const files: string[] = [];
		const regex = this.globToRegex(pattern);

		const walk = async (dir: string) => {
			const entries = await fs.readdir(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				const relativePath = path.relative(cwd, fullPath);

				if (this.shouldIgnore(relativePath, ignore)) continue;

				if (entry.isDirectory()) {
					await walk(fullPath);
				} else if (regex.test(relativePath)) {
					files.push(relativePath);
				}
			}
		};

		await walk(cwd);
		return files.sort();
	}

	private globToRegex(pattern: string): RegExp {
		// First escape all regex special characters, then apply glob transformations
		const regexStr = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*\*/g, "{{GLOBSTAR}}")
			.replace(/\*/g, "[^/]*")
			.replace(/\{\{GLOBSTAR\}\}/g, ".*")
			.replace(/\?/g, "[^/]");

		return new RegExp(`^${regexStr}$`);
	}

	private shouldIgnore(filePath: string, ignore: string[]): boolean {
		for (const pattern of ignore) {
			const regex = this.globToRegex(pattern);
			if (regex.test(filePath)) return true;
		}
		return false;
	}
}
