import * as fs from "node:fs";
import * as path from "node:path";
import type { ValidationCheck } from "../types/validator.js";

// ---------------------------------------------------------------------------
// Types (kept minimal to avoid a hard import of "typescript" at module load)
// ---------------------------------------------------------------------------

interface FileEntry {
	version: number;
	content: string;
}

interface ServiceEntry {
	service: import("typescript").LanguageService;
	host: TsLanguageServiceHost;
	options: import("typescript").CompilerOptions;
	rootNames: string[];
}

// ---------------------------------------------------------------------------
// Singleton registry: workDir → ServiceEntry
// ---------------------------------------------------------------------------

const registry = new Map<string, ServiceEntry>();

// ---------------------------------------------------------------------------
// LanguageServiceHost implementation
// ---------------------------------------------------------------------------

class TsLanguageServiceHost {
	private files = new Map<string, FileEntry>();
	private readonly ts: typeof import("typescript");

	constructor(
		private readonly rootNames: string[],
		private readonly compilerOptions: import("typescript").CompilerOptions,
		private readonly workDir: string,
		ts: typeof import("typescript"),
	) {
		this.ts = ts;
	}

	// ---- file map management ------------------------------------------------

	updateFile(filePath: string, content: string): void {
		const existing = this.files.get(filePath);
		if (existing) {
			existing.version += 1;
			existing.content = content;
		} else {
			this.files.set(filePath, { version: 1, content });
		}
	}

	// ---- ILanguageServiceHost -----------------------------------------------

	getScriptFileNames(): string[] {
		// Union of tsconfig rootNames and any explicitly updated files
		const extra = Array.from(this.files.keys()).filter(
			(f) => !this.rootNames.includes(f),
		);
		return [...this.rootNames, ...extra];
	}

	getScriptVersion(fileName: string): string {
		return String(this.files.get(fileName)?.version ?? 0);
	}

	getScriptSnapshot(
		fileName: string,
	): import("typescript").IScriptSnapshot | undefined {
		const entry = this.files.get(fileName);
		if (entry) {
			return this.ts.ScriptSnapshot.fromString(entry.content);
		}
		// Fall back to disk
		if (!fs.existsSync(fileName)) return undefined;
		try {
			const text = fs.readFileSync(fileName, "utf-8");
			return this.ts.ScriptSnapshot.fromString(text);
		} catch {
			return undefined;
		}
	}

	getCurrentDirectory(): string {
		return this.workDir;
	}

	getCompilationSettings(): import("typescript").CompilerOptions {
		return this.compilerOptions;
	}

	getDefaultLibFileName(options: import("typescript").CompilerOptions): string {
		return this.ts.getDefaultLibFilePath(options);
	}

	fileExists(fileName: string): boolean {
		if (this.files.has(fileName)) return true;
		return fs.existsSync(fileName);
	}

	readFile(fileName: string, encoding?: string): string | undefined {
		const entry = this.files.get(fileName);
		if (entry) return entry.content;
		try {
			return fs.readFileSync(fileName, (encoding ?? "utf-8") as BufferEncoding);
		} catch {
			return undefined;
		}
	}

	readDirectory(
		dirPath: string,
		extensions?: readonly string[],
		exclude?: readonly string[],
		include?: readonly string[],
		depth?: number,
	): string[] {
		return this.ts.sys.readDirectory(
			dirPath,
			extensions,
			exclude,
			include,
			depth,
		);
	}

	directoryExists(dirPath: string): boolean {
		return this.ts.sys.directoryExists(dirPath);
	}

	getDirectories(dirPath: string): string[] {
		return this.ts.sys.getDirectories(dirPath);
	}
}

// ---------------------------------------------------------------------------
// Internal: build or retrieve a ServiceEntry for a workDir
// ---------------------------------------------------------------------------

async function getOrCreateService(
	ts: typeof import("typescript"),
	workDir: string,
): Promise<ServiceEntry> {
	const existing = registry.get(workDir);
	if (existing) return existing;

	// Locate tsconfig.json
	const configPath = ts.findConfigFile(
		workDir,
		ts.sys.fileExists,
		"tsconfig.json",
	);

	let compilerOptions: import("typescript").CompilerOptions = {};
	let rootNames: string[] = [];

	if (configPath) {
		const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
		if (!readResult.error) {
			const parsed = ts.parseJsonConfigFileContent(
				readResult.config as Record<string, unknown>,
				ts.sys,
				path.dirname(configPath),
			);
			compilerOptions = parsed.options;
			rootNames = parsed.fileNames;
		}
	}

	const host = new TsLanguageServiceHost(
		rootNames,
		compilerOptions,
		workDir,
		ts,
	);
	const service = ts.createLanguageService(
		host as import("typescript").LanguageServiceHost,
		ts.createDocumentRegistry(),
	);

	const entry: ServiceEntry = {
		service,
		host,
		options: compilerOptions,
		rootNames,
	};
	registry.set(workDir, entry);
	return entry;
}

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

function toSeverity(
	category: import("typescript").DiagnosticCategory,
): "error" | "warning" | "info" {
	// DiagnosticCategory: Error=1, Warning=0, Message=3, Suggestion=2
	if (category === 1) return "error";
	if (category === 0) return "warning";
	return "info";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns TypeScript semantic + syntactic diagnostics for the given file,
 * using a cached in-process LanguageService per workDir.
 *
 * Falls back to [] if the `typescript` module cannot be imported.
 */
export async function getTsDiagnostics(
	filePath: string,
	workDir: string,
): Promise<ValidationCheck[]> {
	let ts: typeof import("typescript");
	try {
		ts = (await import("typescript")).default as typeof import("typescript");
		// Some builds expose the API directly (not under .default)
		if (
			typeof (ts as unknown as { createLanguageService?: unknown })
				.createLanguageService !== "function"
		) {
			ts = (await import("typescript")) as unknown as typeof import("typescript");
		}
	} catch {
		return [];
	}

	try {
		const { service, host } = await getOrCreateService(ts, workDir);

		// Read current content from disk and update the host
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			return [];
		}
		host.updateFile(filePath, content);

		const syntactic = service.getSyntacticDiagnostics(filePath);
		const semantic = service.getSemanticDiagnostics(filePath);
		const allDiags: import("typescript").Diagnostic[] = [
			...syntactic,
			...semantic,
		];

		if (allDiags.length === 0) {
			return [
				{
					name: "tsc-checker",
					type: "type",
					passed: true,
					message: "tsc: no type errors",
					severity: "info",
				},
			];
		}

		const checks: ValidationCheck[] = [];
		for (const diag of allDiags) {
			const message =
				typeof diag.messageText === "string"
					? diag.messageText
					: diag.messageText.messageText;

			const check: ValidationCheck = {
				name: "tsc-checker",
				type: "type",
				passed: false,
				message: `tsc: ${message}`,
				severity: toSeverity(diag.category),
			};

			if (diag.file && diag.start !== undefined) {
				const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
				check.location = {
					file: diag.file.fileName,
					line: pos.line + 1,
					column: pos.character + 1,
				};
			}

			checks.push(check);
		}
		return checks;
	} catch {
		return [];
	}
}
