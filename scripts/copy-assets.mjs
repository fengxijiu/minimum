#!/usr/bin/env node
// Copies non-TS assets (prompt markdown, etc.) into dist/ after tsc.
// Mirrors the source tree so runtime `import.meta.url` resolution matches.

import { cp, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ASSET_SETS = [
	{ from: "src/personas/prompts", to: "dist/personas/prompts" },
];

for (const { from, to } of ASSET_SETS) {
	const src = path.join(ROOT, from);
	const dst = path.join(ROOT, to);
	await mkdir(dst, { recursive: true });
	await cp(src, dst, { recursive: true });
	console.log(`copied ${from} -> ${to}`);
}
