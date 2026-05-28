import * as fs from "node:fs/promises";
import * as path from "node:path";

export class ListDirectoryTool {
	name = "list_directory";
	description = "List contents of a directory";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Directory path",
					},
					recursive: {
						type: "boolean",
						description: "List recursively",
						default: false,
					},
					showHidden: {
						type: "boolean",
						description: "Show hidden files",
						default: false,
					},
				},
				required: ["path"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string },
	): Promise<string> {
		const dirPath = context?.workingDirectory
			? path.resolve(context.workingDirectory, args.path)
			: path.resolve(args.path);

		try {
			const entries = await this.listDir(
				dirPath,
				args.recursive,
				args.showHidden,
			);
			return entries.join("\n");
		} catch (error: any) {
			return `Error listing directory: ${error.message}`;
		}
	}

	private async listDir(
		dirPath: string,
		recursive: boolean,
		showHidden: boolean,
	): Promise<string[]> {
		const entries: string[] = [];
		const items = await fs.readdir(dirPath, { withFileTypes: true });

		for (const item of items) {
			if (!showHidden && item.name.startsWith(".")) continue;

			const fullPath = path.join(dirPath, item.name);
			const relativePath = path.relative(process.cwd(), fullPath);

			if (item.isDirectory()) {
				entries.push(`${relativePath}/`);
				if (recursive) {
					const subEntries = await this.listDir(
						fullPath,
						recursive,
						showHidden,
					);
					entries.push(...subEntries);
				}
			} else {
				entries.push(relativePath);
			}
		}

		return entries;
	}
}
