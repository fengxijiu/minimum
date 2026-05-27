import * as path from "path";
import * as fs from "fs/promises";

export class WriteFileTool {
	name = "write_file";
	description = "Write content to a file";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Path to the file to write",
					},
					content: {
						type: "string",
						description: "Content to write",
					},
					encoding: {
						type: "string",
						description: "File encoding (default: utf-8)",
						default: "utf-8",
					},
					createDirs: {
						type: "boolean",
						description: "Create parent directories if they don't exist",
						default: false,
					},
				},
				required: ["path", "content"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string },
	): Promise<string> {
		const filePath = context?.workingDirectory
			? path.resolve(context.workingDirectory, args.path)
			: path.resolve(args.path);

		try {
			if (args.createDirs) {
				await fs.mkdir(path.dirname(filePath), { recursive: true });
			}

			await fs.writeFile(filePath, args.content, args.encoding || "utf-8");
			return `File written successfully: ${args.path}`;
		} catch (error: any) {
			return `Error writing file: ${error.message}`;
		}
	}
}
