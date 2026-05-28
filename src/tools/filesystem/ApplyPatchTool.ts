import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ToolDefinition } from "../../types/common.js";

export interface Hunk {
	search: string;
	replace: string;
}

export class ApplyPatchTool {
	name = "apply_patch";
	description =
		"Apply targeted edits to a file using search/replace hunks. Safer than write_file because each search string must match exactly once — preventing blind overwrites.";

	getDefinition(): ToolDefinition {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Path to the file to patch",
					},
					hunks: {
						type: "array",
						description:
							"Ordered list of search/replace pairs to apply sequentially",
						items: {
							type: "object",
							properties: {
								search: {
									type: "string",
									description: "Exact text to find in the file",
								},
								replace: {
									type: "string",
									description: "Text to substitute in place of the search text",
								},
							},
							required: ["search", "replace"],
						},
					},
				},
				required: ["path", "hunks"],
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

		let content: string;
		try {
			content = await fs.readFile(filePath, "utf-8");
		} catch (error: any) {
			return `Error reading file: ${error.message}`;
		}

		const hunks: Hunk[] = args.hunks;
		let linesChanged = 0;

		for (let i = 0; i < hunks.length; i++) {
			const hunk = hunks[i]!;
			const { search, replace } = hunk;

			// Count occurrences of search text in current content
			let occurrences = 0;
			let pos = 0;
			while (true) {
				const idx = content.indexOf(search, pos);
				if (idx === -1) break;
				occurrences++;
				pos = idx + 1;
			}

			if (occurrences === 0) {
				const preview =
					search.length > 80 ? search.substring(0, 80) + "..." : search;
				return `Error: hunk ${i + 1} search text not found in ${args.path}: "${preview}"`;
			}

			if (occurrences > 1) {
				const preview =
					search.length > 80 ? search.substring(0, 80) + "..." : search;
				return (
					`Error: hunk ${i + 1} search text is ambiguous — found ${occurrences} occurrences in ${args.path}: "${preview}". ` +
					`Add more surrounding context to make the search text unique.`
				);
			}

			// Apply the single match
			const matchIndex = content.indexOf(search);
			const before = content.substring(0, matchIndex);
			const after = content.substring(matchIndex + search.length);
			content = before + replace + after;

			// Tally line delta for the summary
			const removedLines = search.split("\n").length;
			const addedLines = replace.split("\n").length;
			linesChanged += Math.abs(addedLines - removedLines) + Math.min(removedLines, addedLines);
		}

		try {
			await fs.writeFile(filePath, content, "utf-8");
		} catch (error: any) {
			return `Error writing file: ${error.message}`;
		}

		return `Applied ${hunks.length} hunk(s) to ${args.path} (~${linesChanged} line(s) affected)`;
	}
}
