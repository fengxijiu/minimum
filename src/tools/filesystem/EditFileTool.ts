import * as path from "path";
import * as fs from "fs/promises";

export interface EditOperation {
	search: string;
	replace: string;
}

export class EditFileTool {
	name = "edit_file";
	description = "Edit a file using SEARCH/REPLACE blocks";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Path to the file to edit",
					},
					edits: {
						type: "array",
						items: {
							type: "object",
							properties: {
								search: { type: "string" },
								replace: { type: "string" },
							},
							required: ["search", "replace"],
						},
						description: "List of SEARCH/REPLACE edits",
					},
				},
				required: ["path", "edits"],
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
			let content = await fs.readFile(filePath, "utf-8");

			for (const edit of args.edits) {
				const index = content.indexOf(edit.search);
				if (index === -1) {
					return `Error: SEARCH text not found: ${edit.search.substring(0, 50)}...`;
				}
				content =
					content.substring(0, index) +
					edit.replace +
					content.substring(index + edit.search.length);
			}

			await fs.writeFile(filePath, content, "utf-8");
			return `File edited successfully: ${args.path}`;
		} catch (error: any) {
			return `Error editing file: ${error.message}`;
		}
	}
}
