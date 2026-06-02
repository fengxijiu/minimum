import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReadTracker } from "../../loop/ReadTracker.js";

export interface ReadFileOptions {
	encoding?: string;
	startLine?: number;
	endLine?: number;
}

export class ReadFileTool {
	name = "read_file";
	description = "Read the contents of a file";

	private readonly readTracker?: ReadTracker;

	constructor(options: { readTracker?: ReadTracker } = {}) {
		this.readTracker = options.readTracker;
	}

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Path to the file to read",
					},
					encoding: {
						type: "string",
						description: "File encoding (default: utf-8)",
						default: "utf-8",
					},
					startLine: {
						type: "number",
						description: "Start line number (1-indexed)",
					},
					endLine: {
						type: "number",
						description: "End line number (1-indexed)",
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
		const filePath = context?.workingDirectory
			? path.resolve(context.workingDirectory, args.path)
			: path.resolve(args.path);

		try {
			const encoding = args.encoding || "utf-8";
			const content = await fs.readFile(filePath, {
				encoding: encoding as BufferEncoding,
			});

			// Mark file as read only when reading the full file (not a partial range)
			if (args.startLine === undefined && args.endLine === undefined) {
				this.readTracker?.markRead(filePath);
			}

			if (args.startLine !== undefined || args.endLine !== undefined) {
				const lines = content.split("\n");
				const start = (args.startLine || 1) - 1;
				const end = args.endLine || lines.length;
				return lines.slice(start, end).join("\n");
			}

			return content;
		} catch (error: any) {
			return `Error reading file: ${error.message}`;
		}
	}
}
