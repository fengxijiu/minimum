import * as path from "node:path";
import { defaultManifest } from "./MemoryManifest.js";
import type { MemoryCandidate } from "./types.js";

/** NEW: expose the default canonical target set so W4 can hint valid writeback files. */
export function availableCanonicalMemoryTargets(): string[] {
	return [...new Set(Object.values(defaultManifest().canonicalFiles).map((rel) => path.basename(rel)))];
}

/** NEW: share the scope-to-target fallback used by both single-agent and W4 memory writes. */
export function defaultMemoryTargetForCandidate(candidate: MemoryCandidate): string {
	const scope = candidate.scope.toLowerCase();
	if (scope.includes("global") || scope.includes("user")) return "global.md";
	if (scope.includes("frontend")) return "frontend.md";
	if (scope.includes("backend")) return "backend.md";
	if (scope.includes("api")) return "api.md";
	return "project.md";
}

/** NEW: keep section routing aligned across the two memory write paths. */
export function defaultMemorySectionForCandidate(candidate: MemoryCandidate): string {
	if (isGlobalMemory(candidate)) return "User Preferences";
	return candidate.scope === "none"
		? "Notes"
		: titleCase(candidate.scope.split(/[/:]/)[0] ?? "Notes");
}

function isGlobalMemory(candidate: MemoryCandidate): boolean {
	const scope = candidate.scope.toLowerCase();
	return scope.includes("global") || scope.includes("user");
}

function titleCase(value: string): string {
	return value.length === 0 ? "Notes" : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
