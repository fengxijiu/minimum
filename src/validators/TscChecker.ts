import * as fs from "node:fs";
import * as path from "node:path";
import type {
	IChecker,
	ValidationCheck,
	ValidationRequest,
} from "../types/validator.js";
import { getTsDiagnostics } from "../lsp/index.js";

const TS_EXTS = new Set(["ts", "tsx"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * TscChecker — uses the TypeScript compiler API in-process via a cached
 * LanguageService singleton (one per working directory).  This replaces the
 * previous spawnSync(tsc) approach and reduces per-call latency from 2–15 s
 * down to tens of milliseconds after the first warm-up.
 *
 * Falls back to [] silently if the `typescript` module is unavailable or if
 * any unexpected error occurs.
 */
export class TscChecker implements IChecker {
	name = "tsc-checker";
	type = "type" as const;

	async check(request: ValidationRequest): Promise<ValidationCheck[]> {
		if (!WRITE_TOOLS.has(request.toolName)) return [];

		const rawPath = request.toolArgs?.path as string | undefined;
		if (!rawPath) return [];

		const ext = rawPath.split(".").pop()?.toLowerCase();
		if (!ext || !TS_EXTS.has(ext)) return [];

		const workDir = request.workingDirectory || process.cwd();
		const absPath = path.isAbsolute(rawPath)
			? rawPath
			: path.resolve(workDir, rawPath);

		if (!fs.existsSync(absPath)) return [];

		try {
			return await getTsDiagnostics(absPath, workDir);
		} catch {
			return [];
		}
	}
}
