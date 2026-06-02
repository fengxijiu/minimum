import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import { grammarForPath } from "./grammar-map.js";

const UNSUPPORTED =
	"language not supported (TS/TSX/JS/JSX/Python/Go/Rust/Java); use grep/search for text matching";

export class SymbolsTool {
	name = "get_symbols";
	description =
		"Outline a single TS/TSX/JS/JSX/Python/Go/Rust/Java file via tree-sitter and return its symbols.";

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "File path, relative to the project root or absolute.",
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
		const rawPath = typeof args.path === "string" ? args.path : "";
		const filePath = resolveProjectPath(context?.workingDirectory, rawPath);
		if (!grammarForPath(filePath)) {
			return JSON.stringify({ path: rawPath, error: UNSUPPORTED });
		}
		const source = await readFile(filePath, "utf8");
		const { extractSymbols } = await import("./symbols.js");
		const symbols = await extractSymbols(filePath, source);
		return JSON.stringify({ path: rawPath, symbols });
	}
}

function resolveProjectPath(rootDir: string | undefined, raw: string): string {
	if (!raw) return pathResolve(rootDir ?? process.cwd(), ".");
	const stripped = raw.replace(/^[/\\]+/, "");
	return pathResolve(rootDir ?? process.cwd(), stripped.length === 0 ? "." : stripped);
}
