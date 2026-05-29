import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Manifest, ManifestRules } from "./types.js";

/**
 * MemoryManifest — read/write `.minimum/manifest.yaml`.
 *
 * Uses a tiny hand-rolled YAML reader scoped to the structure we control
 * (keys are alphanumeric/underscore, values are strings/booleans/lists of
 * strings). Avoids pulling in a YAML dep for one config file.
 *
 * If the manifest is missing, getOrInit() creates one with sensible
 * defaults so the very first `/init` works without a wizard.
 */

const DEFAULT_CANONICAL: Record<string, string> = {
	project: ".minimum/project.md",
	architecture: ".minimum/architecture.md",
	conventions: ".minimum/conventions.md",
	repo_map: ".minimum/repo-map.md",
	tests: ".minimum/tests.md",
	visual: ".minimum/visual.md",
	runtime: ".minimum/runtime.md",
	risks: ".minimum/risks.md",
	decisions: ".minimum/decisions.md",
	api: ".minimum/api.md",
	frontend: ".minimum/frontend.md",
	backend: ".minimum/backend.md",
};

const DEFAULT_LOAD_POLICY: Record<string, string[]> = {
	always: ["project", "architecture", "repo_map", "conventions", "tests"],
	frontend: ["visual", "frontend"],
	backend: ["backend", "api", "data_model"],
	debugging: ["runtime", "risks", "tests"],
};

const DEFAULT_RULES: ManifestRules = {
	subagentsCanWriteStaging: true,
	subagentsCanWriteCanonical: false,
	mainAgentMergesMemory: true,
	requireEvidenceForMemory: true,
	archiveDeprecatedMemory: true,
};

export function defaultManifest(memoryRoot = ".minimum"): Manifest {
	return {
		version: 1,
		memoryRoot,
		canonicalFiles: { ...DEFAULT_CANONICAL },
		staging: { path: `${memoryRoot}/_staging`, pattern: "*.memory.md" },
		loadPolicy: { ...DEFAULT_LOAD_POLICY },
		rules: { ...DEFAULT_RULES },
	};
}

/** Resolve canonical filename to its absolute path under the project root. */
export function canonicalPath(
	manifest: Manifest,
	projectRoot: string,
	key: string,
): string | null {
	const rel = manifest.canonicalFiles[key];
	return rel ? path.join(projectRoot, rel) : null;
}

/** Persist a manifest as YAML. */
export async function writeManifest(
	projectRoot: string,
	manifest: Manifest,
): Promise<void> {
	const filePath = path.join(projectRoot, manifest.memoryRoot, "manifest.yaml");
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, serializeYaml(manifest), "utf-8");
}

/** Read the manifest; create with defaults if missing. */
export async function getOrInitManifest(
	projectRoot: string,
	memoryRoot = ".minimum",
): Promise<Manifest> {
	const filePath = path.join(projectRoot, memoryRoot, "manifest.yaml");
	try {
		const text = await fs.readFile(filePath, "utf-8");
		return parseYaml(text);
	} catch {
		const manifest = defaultManifest(memoryRoot);
		await writeManifest(projectRoot, manifest);
		return manifest;
	}
}

// ── Tiny YAML serializer/parser ─────────────────────────────────────────────
// Scope: handles the exact shape of Manifest (scalars, string maps, list
// of strings, nested object 1 level deep). Anything outside this shape is
// rejected by parseYaml with a thrown error.

function serializeYaml(m: Manifest): string {
	const lines: string[] = [];
	lines.push(`version: ${m.version}`);
	lines.push(`memory_root: "${escape(m.memoryRoot)}"`);
	lines.push("canonical_files:");
	for (const [k, v] of Object.entries(m.canonicalFiles)) {
		lines.push(`  ${k}: "${escape(v)}"`);
	}
	lines.push("staging:");
	lines.push(`  path: "${escape(m.staging.path)}"`);
	lines.push(`  pattern: "${escape(m.staging.pattern)}"`);
	lines.push("rules:");
	for (const [k, v] of Object.entries(m.rules)) {
		lines.push(`  ${camelToSnake(k)}: ${v}`);
	}
	lines.push("load_policy:");
	for (const [k, v] of Object.entries(m.loadPolicy)) {
		lines.push(`  ${k}:`);
		for (const item of v) lines.push(`    - ${item}`);
	}
	return lines.join("\n") + "\n";
}

export function parseYaml(text: string): Manifest {
	const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, ""));
	let i = 0;
	const manifest: Manifest = defaultManifest();

	while (i < lines.length) {
		const raw = lines[i]!;
		const line = raw.trimEnd();
		if (!line.trim()) { i++; continue; }

		const [keyRaw, ...valParts] = line.split(":");
		const key = keyRaw!.trim();
		const value = valParts.join(":").trim();

		if (key === "version") manifest.version = Number(value);
		else if (key === "memory_root") manifest.memoryRoot = unquote(value);
		else if (key === "canonical_files") {
			i++;
			const map: Record<string, string> = {};
			while (i < lines.length && lines[i]!.startsWith("  ") && !lines[i]!.startsWith("    ")) {
				const sub = lines[i]!.trim();
				if (!sub) { i++; continue; }
				const [k, ...rest] = sub.split(":");
				map[k!.trim()] = unquote(rest.join(":").trim());
				i++;
			}
			manifest.canonicalFiles = map;
			continue;
		}
		else if (key === "staging") {
			i++;
			while (i < lines.length && lines[i]!.startsWith("  ") && !lines[i]!.startsWith("    ")) {
				const sub = lines[i]!.trim();
				if (!sub) { i++; continue; }
				const [k, ...rest] = sub.split(":");
				const v = unquote(rest.join(":").trim());
				if (k!.trim() === "path") manifest.staging.path = v;
				else if (k!.trim() === "pattern") manifest.staging.pattern = v;
				i++;
			}
			continue;
		}
		else if (key === "rules") {
			i++;
			const rules: Record<string, boolean> = {};
			while (i < lines.length && lines[i]!.startsWith("  ") && !lines[i]!.startsWith("    ")) {
				const sub = lines[i]!.trim();
				if (!sub) { i++; continue; }
				const [k, ...rest] = sub.split(":");
				rules[snakeToCamel(k!.trim())] = rest.join(":").trim() === "true";
				i++;
			}
			manifest.rules = { ...manifest.rules, ...(rules as Partial<ManifestRules>) };
			continue;
		}
		else if (key === "load_policy") {
			i++;
			const policy: Record<string, string[]> = {};
			while (i < lines.length && lines[i]!.startsWith("  ") && !lines[i]!.startsWith("    ")) {
				const sub = lines[i]!.replace(/^  /, "");
				if (!sub.trim()) { i++; continue; }
				const polKey = sub.split(":")[0]!.trim();
				policy[polKey] = [];
				i++;
				while (i < lines.length && lines[i]!.startsWith("    - ")) {
					policy[polKey]!.push(lines[i]!.replace("    - ", "").trim());
					i++;
				}
			}
			manifest.loadPolicy = policy;
			continue;
		}
		i++;
	}
	return manifest;
}

function escape(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unquote(s: string): string {
	const t = s.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
		return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	return t;
}

function camelToSnake(s: string): string {
	return s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
}

function snakeToCamel(s: string): string {
	return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
