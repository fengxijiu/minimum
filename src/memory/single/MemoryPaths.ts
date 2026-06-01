import * as os from "node:os";
import * as path from "node:path";

export type MemoryLayerScope = "project" | "global";

export interface ProjectMemoryLayer {
	scope: "project";
	projectRoot: string;
}

export interface GlobalMemoryLayer {
	scope: "global";
	homeDir?: string;
}

export type MemoryLayer = ProjectMemoryLayer | GlobalMemoryLayer;

const WINDOWS_ABSOLUTE_RE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

/** Resolve the project-local canonical memory root: `<project>/.minimum/memory`. */
export function getProjectMemoryRoot(projectRoot: string): string {
	return joinForRoot(projectRoot, ".minimum", "memory");
}

/** Resolve the user-global canonical memory root: `~/.minimum/memory`. */
export function getGlobalMemoryRoot(homeDir: string = os.homedir()): string {
	return joinForRoot(homeDir || "~", ".minimum", "memory");
}

/** Resolve a canonical markdown file path for a memory layer/key pair. */
export function getMemoryFile(layer: MemoryLayer, key: string): string {
	return joinForRoot(getLayerRoot(layer), `${sanitizeMemoryKey(key)}.md`);
}

/** Resolve the auxiliary JSON index path for a memory layer. */
export function getMemoryIndexPath(layer: MemoryLayer): string {
	return joinForRoot(getLayerRoot(layer), "index.json");
}

export function projectMemoryLayer(projectRoot: string): ProjectMemoryLayer {
	return { scope: "project", projectRoot };
}

export function globalMemoryLayer(homeDir?: string): GlobalMemoryLayer {
	return homeDir ? { scope: "global", homeDir } : { scope: "global" };
}

export function sanitizeMemoryKey(key: string): string {
	const trimmed = key.trim().replace(/\.md$/i, "");
	return (
		trimmed
			.replace(/[\\/]+/g, "-")
			.replace(/[^a-zA-Z0-9._-]/g, "_")
			.replace(/^\.+/, "")
			.substring(0, 100) || "memory"
	);
}

function getLayerRoot(layer: MemoryLayer): string {
	return layer.scope === "project"
		? getProjectMemoryRoot(layer.projectRoot)
		: getGlobalMemoryRoot(layer.homeDir);
}

function joinForRoot(root: string, ...segments: string[]): string {
	const pathApi = isWindowsPath(root) ? path.win32 : path.posix;
	return pathApi.normalize(pathApi.join(root, ...segments));
}

function isWindowsPath(input: string): boolean {
	return WINDOWS_ABSOLUTE_RE.test(input);
}
