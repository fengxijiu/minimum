import * as fs from "fs";
import * as path from "path";

export interface FileItem {
	path: string;
	type: "file" | "dir";
	name: string;
}

const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	"__pycache__",
	"venv",
	".venv",
]);

export function listWorkspaceFiles(
	root: string,
	options: { maxDepth?: number; maxItems?: number } = {},
): FileItem[] {
	const maxDepth = options.maxDepth ?? 4;
	const maxItems = options.maxItems ?? 400;
	const result: FileItem[] = [];

	function walk(dir: string, prefix: string, depth: number): void {
		if (depth > maxDepth || result.length >= maxItems) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (result.length >= maxItems) return;
			if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
			if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;

			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				result.push({ path: rel, type: "dir", name: entry.name });
				walk(full, rel, depth + 1);
			} else {
				result.push({ path: rel, type: "file", name: entry.name });
			}
		}
	}

	walk(root, "", 0);
	return result;
}

export function resolveFileMention(root: string, token: string): string {
	const files = listWorkspaceFiles(root);
	const exact = files.find((file) => file.path === token || file.name === token);
	if (exact) return exact.path;
	const partial = files.find((file) => file.path.includes(token));
	return partial?.path ?? token;
}
