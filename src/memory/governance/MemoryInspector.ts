import * as fs from "node:fs/promises";
import { canonicalPath, getOrInitManifest } from "./MemoryManifest.js";
import { readMemoryIndex } from "./MemoryIndex.js";
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
	id: string;
	sourceTask: string;
	persona: string;
	scope: string;
	confidence: string;
	relatedFiles: string[];
	decision?: string;
	reviewReason?: string;
}

export interface MemoryIndexInfo {
	path: string;
	exists: boolean;
	entryCount: number;
	missingCount: number;
	generatedAt?: string;
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
		id: `${c.sourceTask}.${c.persona}`,
		sourceTask: c.sourceTask,
		persona: c.persona,
		scope: c.scope,
		confidence: c.confidence,
		relatedFiles: c.relatedFiles,
		...(c.decision && { decision: c.decision }),
		...(c.reviewReason && { reviewReason: c.reviewReason }),
	}));
}

/** Summarize the generated deterministic memory index. */
export async function inspectMemoryIndex(projectRoot: string): Promise<MemoryIndexInfo> {
	const index = await readMemoryIndex(projectRoot);
	if (!index) {
		return {
			path: ".minimum/index.json",
			exists: false,
			entryCount: 0,
			missingCount: 0,
		};
	}
	return {
		path: `${index.memoryRoot}/index.json`,
		exists: true,
		entryCount: index.entries.length,
		missingCount: index.entries.filter((entry) => !entry.exists).length,
		generatedAt: index.generatedAt,
	};
}

/** Render a compact text report for the `/memory` command. */
export function renderMemoryReport(
	canonical: CanonicalFileInfo[],
	staging: StagingInfo[],
	index?: MemoryIndexInfo,
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
			const decision = s.decision ? ` ${s.decision}` : "";
			const reason = s.reviewReason ? ` — ${s.reviewReason}` : "";
			lines.push(`  • ${s.sourceTask}.${s.persona} [${s.confidence}${decision}] ${s.scope}${reason}`);
		}
	}
	if (index) {
		lines.push("");
		lines.push("Index:");
		if (!index.exists) {
			lines.push(`  ○ ${index.path} (missing)`);
		} else {
			const missing = index.missingCount > 0 ? `, ${index.missingCount} missing` : "";
			lines.push(`  ● ${index.path} (${index.entryCount} entries${missing})`);
		}
	}
	return lines.join("\n");
}
