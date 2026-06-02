#!/usr/bin/env node

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const destDir = resolve(__dirname, "..", "dist", "grammars");

mkdirSync(destDir, { recursive: true });

const packages = [
	"tree-sitter-typescript",
	"tree-sitter-javascript",
	"tree-sitter-python",
	"tree-sitter-go",
	"tree-sitter-rust",
	"tree-sitter-java",
];

for (const pkg of packages) {
	let pkgRoot;
	try {
		pkgRoot = dirname(require.resolve(`${pkg}/package.json`));
	} catch {
		console.warn(`[copy-grammars] ${pkg} not installed - skipping`);
		continue;
	}

	const wasmFiles = readdirSync(pkgRoot).filter((file) => file.endsWith(".wasm"));
	for (const wasmFile of wasmFiles) {
		const src = join(pkgRoot, wasmFile);
		const dst = join(destDir, wasmFile);
		copyFileSync(src, dst);
		console.log(`[copy-grammars] ${wasmFile} -> dist/grammars/`);
	}
}
