import * as fs from "node:fs/promises";
import { CharBudget } from "../../utils/tokenBudget.js";
import { canonicalPath, getOrInitManifest } from "./MemoryManifest.js";
import type { Manifest } from "./types.js";

/**
 * MemoryLoader — assemble the W0 canonical-memory prefix for master_planner.
 *
 * Task-type aware (frontend / backend / debugging / mixed); reads the
 * manifest's `load_policy` to decide which canonical files to include.
 * Output is hard-capped at DEFAULT_MAX_TOKENS so master's context budget
 * stays bounded even if a project accumulates large canonical files.
 */

export type TaskType = "frontend" | "backend" | "debugging" | "mixed";

const DEFAULT_MAX_TOKENS = 8_000;

export interface LoadOptions {
	maxTokens?: number;
	manifest?: Manifest;
}

export interface LoadedMemory {
	text: string;
	includedKeys: string[];
	truncated: boolean;
	approxTokens: number;
}

/**
 * Load canonical memory keyed by taskType. Returns an empty/no-op prefix if
 * the manifest defines no policy for the type or all files are missing.
 */
export async function loadCanonicalMemory(
	projectRoot: string,
	taskType: TaskType,
	opts: LoadOptions = {},
): Promise<LoadedMemory> {
	const manifest = opts.manifest ?? (await getOrInitManifest(projectRoot));
	const budget = new CharBudget(opts.maxTokens ?? DEFAULT_MAX_TOKENS);

	const keys = resolveLoadKeys(manifest, taskType);
	const includedKeys: string[] = [];

	budget.pushAlways("# Canonical Project Memory\n");

	for (const key of keys) {
		const absPath = canonicalPath(manifest, projectRoot, key);
		if (!absPath) continue;
		let content: string;
		try {
			content = await fs.readFile(absPath, "utf-8");
		} catch {
			continue; // missing canonical file — skip silently
		}
		const trimmed = content.trim();
		if (!trimmed) continue;

		const header = `\n## ${key} (\`${manifest.canonicalFiles[key]}\`)\n\n`;
		const block = header + trimmed + "\n";
		if (!budget.tryPush(block)) break;
		includedKeys.push(key);
	}

	return {
		text: budget.text,
		includedKeys,
		truncated: budget.truncated,
		approxTokens: budget.approxTokens,
	};
}

/** Deduplicated ordered list of canonical keys to load for a task type. */
export function resolveLoadKeys(manifest: Manifest, taskType: TaskType): string[] {
	const always = manifest.loadPolicy.always ?? [];
	let extra: string[] = [];
	if (taskType === "frontend") extra = manifest.loadPolicy.frontend ?? [];
	else if (taskType === "backend") extra = manifest.loadPolicy.backend ?? [];
	else if (taskType === "debugging") extra = manifest.loadPolicy.debugging ?? [];
	else if (taskType === "mixed") {
		extra = [
			...(manifest.loadPolicy.frontend ?? []),
			...(manifest.loadPolicy.backend ?? []),
		];
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const k of [...always, ...extra]) {
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(k);
	}
	return out;
}
