import * as fs from "node:fs/promises";
import { canonicalPath, getOrInitManifest } from "./MemoryManifest.js";
import { listCandidates } from "./MemoryStaging.js";
import type { Manifest } from "./types.js";

/**
 * MemoryInspector — read-only views of the governance state for the `/memory`
 * command and the TUI. No mutation; everything here is a pure report.
 */

export interface CanonicalFileInfo {
	key: string;
	path: string;
	exists: boolean;
	bytes: number;
}

export interface StagingInfo {
	sourceTask: string;
	persona: string;
	scope: string;
	confidence: string;
	relatedFiles: string[];
}

/** Summarize canonical files declared in the manifest. */
export async function inspectCanonical(
	projectRoot: string,
	manifest?: Manifest,
): Promise<CanonicalFileInfo[]> {
	const m = manifest ?? (await getOrInitManifest(projectRoot));
	const out: CanonicalFileInfo[] = [];
	for (const [key, rel] of Object.entries(m.canonicalFiles)) {
		const abs = canonicalPath(m, projectRoot, key);
		let exists = false;
		let bytes = 0;
		if (abs) {
			try {
				const stat = await fs.stat(abs);
				exists = true;
				bytes = stat.size;
			} catch {
				exists = false;
			}
		}
		out.push({ key, path: rel, exists, bytes });
	}
	return out;
}

/** Summarize staged candidates awaiting W4 governance. */
export async function inspectStaging(projectRoot: string): Promise<StagingInfo[]> {
	const candidates = await listCandidates(projectRoot);
	return candidates.map((c) => ({
		sourceTask: c.sourceTask,
		persona: c.persona,
		scope: c.scope,
		confidence: c.confidence,
		relatedFiles: c.relatedFiles,
	}));
}

/** Render a compact text report for the `/memory` command. */
export function renderMemoryReport(
	canonical: CanonicalFileInfo[],
	staging: StagingInfo[],
): string {
	const lines: string[] = [];
	lines.push("Canonical memory:");
	if (canonical.length === 0) {
		lines.push("  (none declared)");
	} else {
		for (const c of canonical) {
			const status = c.exists ? `${c.bytes}B` : "missing";
			lines.push(`  ${c.exists ? "●" : "○"} ${c.key.padEnd(14)} ${c.path} (${status})`);
		}
	}
	lines.push("");
	lines.push(`Staging (${staging.length} candidate${staging.length === 1 ? "" : "s"}):`);
	if (staging.length === 0) {
		lines.push("  (empty)");
	} else {
		for (const s of staging) {
			lines.push(`  • ${s.sourceTask}.${s.persona} [${s.confidence}] ${s.scope}`);
		}
	}
	return lines.join("\n");
}
