#!/usr/bin/env node
/**
 * Sync persona prompts and inline-skills from src/ to dist/.
 *
 * Copies:
 *   src/personas/prompts/**         → dist/personas/prompts/**
 *   src/personas/inline-skills/**   → dist/personas/inline-skills/**
 *   src/skills/system/**            → dist/skills/system/**
 *
 * Usage:
 *   node scripts/sync-dist-prompts.js
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const pairs = [
  ["src/personas/prompts",       "dist/personas/prompts"],
  ["src/personas/inline-skills", "dist/personas/inline-skills"],
  ["src/skills/system",          "dist/skills/system"],
];

let copied = 0;
for (const [src, dst] of pairs) {
  const srcAbs = resolve(root, src);
  const dstAbs = resolve(root, dst);
  if (!existsSync(srcAbs)) {
    console.warn(`[sync] skip (not found): ${src}`);
    continue;
  }
  mkdirSync(dstAbs, { recursive: true });
  cpSync(srcAbs, dstAbs, { recursive: true, force: true });
  console.log(`[sync] ${src} → ${dst}`);
  copied++;
}
console.log(`[sync] done — ${copied} dir(s) synced.`);
