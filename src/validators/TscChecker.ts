import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	IChecker,
	ValidationCheck,
	ValidationRequest,
} from "../types/validator.js";

const TS_EXTS = new Set(["ts", "tsx"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

// Matches: src/foo.ts(10,5): error TS2322: message
const DIAG_RE = /^(.+)\((\d+),(\d+)\): (error|warning) TS\d+: (.+)$/;

/**
 * TscChecker — 参考 CodeWhale 的 PostTool→LSP→回模型流程的 TS 平价版。
 *
 * 在 write_file / edit_file 后对 TS/TSX 文件跑 tsc --noEmit，
 * 把编译器诊断（类型错误、未定义变量、API 参数错误）作为 ValidationCheck 回灌给模型，
 * 直接替代只做正则匹配的 TypeChecker。
 *
 * 如果 tsc 不可用或超时，静默跳过（不阻塞流程）。
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

		const tscPath = this.findTsc(workDir);
		if (!tscPath) return [];

		const result = spawnSync(
			tscPath,
			["--noEmit", "--skipLibCheck", "--strict", "false"],
			{
				cwd: workDir,
				encoding: "utf-8",
				timeout: 15_000,
			},
		);

		if (result.error) return [];

		const output = (result.stdout || "") + (result.stderr || "");
		return this.parseDiagnostics(output, absPath, workDir);
	}

	private parseDiagnostics(
		output: string,
		absPath: string,
		workDir: string,
	): ValidationCheck[] {
		const checks: ValidationCheck[] = [];

		for (const line of output.split("\n")) {
			const m = DIAG_RE.exec(line.trim());
			if (!m) continue;

			const [, filePart, lineStr, colStr, level, message] = m;
			const diagAbs = path.isAbsolute(filePart!)
				? filePart!
				: path.resolve(workDir, filePart!);

			if (diagAbs !== absPath) continue;

			checks.push({
				name: this.name,
				type: this.type,
				passed: false,
				message: `tsc: ${message}`,
				severity: level === "error" ? "error" : "warning",
				location: {
					file: filePart!,
					line: Number(lineStr),
					column: Number(colStr),
				},
			});
		}

		if (checks.length === 0 && output.trim() === "") {
			checks.push({
				name: this.name,
				type: this.type,
				passed: true,
				message: "tsc: no type errors",
				severity: "info",
			});
		}

		return checks;
	}

	private findTsc(workDir: string): string | null {
		const local = path.join(workDir, "node_modules", ".bin", "tsc");
		if (fs.existsSync(local)) return local;

		// fallback: tsc on PATH
		const result = spawnSync("which", ["tsc"], { encoding: "utf-8" });
		if (result.status === 0 && result.stdout.trim()) {
			return result.stdout.trim();
		}
		return null;
	}
}
