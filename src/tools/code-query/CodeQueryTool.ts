import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import type { CodeMatchKind, FindInCodeOptions } from "./find-in-code.js";
import { grammarForPath } from "./grammar-map.js";

const UNSUPPORTED =
	"language not supported (TS/TSX/JS/JSX/Python/Go/Rust/Java); use grep/search for text matching";

export class CodeQueryTool {
	name = "find_in_code";
	description =
		"Find an identifier in a single TS/TSX/JS/JSX/Python/Go/Rust/Java file, AST-filtered to skip comments and strings.";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					name: {
						type: "string",
						description: "Exact identifier text to find.",
					},
					path: {
						type: "string",
						description: "File path, relative to the project root or absolute.",
					},
					kind: {
						type: "string",
						enum: ["any", "call", "definition", "reference"],
						description: "Optional syntactic role filter.",
					},
				},
				required: ["name", "path"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string },
	): Promise<string> {
		const rawPath = typeof args.path === "string" ? args.path : "";
		const filePath = resolveProjectPath(context?.workingDirectory, rawPath);
		if (!grammarForPath(filePath)) {
			return JSON.stringify({ path: rawPath, error: UNSUPPORTED });
		}
		const source = await readFile(filePath, "utf8");
		const kind = (args.kind ?? "any") as CodeMatchKind | "any";
		const findOpts: FindInCodeOptions = kind === "any" ? {} : { kind };
		const { findInCode } = await import("./find-in-code.js");
		const matches = await findInCode(filePath, source, String(args.name ?? ""), findOpts);
		return JSON.stringify({ path: rawPath, matches });
	}
}

function resolveProjectPath(rootDir: string | undefined, raw: string): string {
	if (!raw) return pathResolve(rootDir ?? process.cwd(), ".");
	const stripped = raw.replace(/^[/\\]+/, "");
	return pathResolve(rootDir ?? process.cwd(), stripped.length === 0 ? "." : stripped);
}
