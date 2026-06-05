import { spawn, type SpawnOptions } from "node:child_process";
import * as pathMod from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { truncateToolResult } from "../truncateResult.js";
import type { ApprovalManager } from "../../approval/ApprovalManager.js";

export type DependencyManager =
	| "npm"
	| "pnpm"
	| "yarn"
	| "bun"
	| "pip"
	| "uv"
	| "poetry"
	| "pipenv";

const ALL_MANAGERS: ReadonlySet<string> = new Set([
	"npm", "pnpm", "yarn", "bun",
	"pip", "uv", "poetry", "pipenv",
]);

const NODE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
const PYTHON_MANAGERS: ReadonlySet<string> = new Set(["pip", "uv", "poetry", "pipenv"]);

const DANGEROUS_PACKAGE_RE = /[;&|`$<>(){}!#\n\r\\]/;
const PIP_URL_RE = /^(https?:|git\+|file:|-e\s)/;
const PIP_FLAG_DENYLIST: ReadonlySet<string> = new Set([
	"--index-url", "--extra-index-url", "--trusted-host",
	"--pre", "--force-reinstall", "--break-system-packages",
	"-r", "-c", "--requirement", "--constraint",
]);

export interface InstallDependencyToolOptions {
	rootDir?: string;
	timeoutSec?: number;
	maxOutputChars?: number;
	approvalManager?: ApprovalManager;
}

export class InstallDependencyTool {
	name = "install_dependency";
	description =
		"Install project dependencies via a supported package manager (npm, pnpm, yarn, bun, pip, uv, poetry, pipenv). Structured parameters only — no raw shell commands. Lifecycle scripts are disabled by default. pip requires runtimeOnly or requirementsPath.";

	private readonly rootDir?: string;
	private readonly defaultTimeoutSec: number;
	private readonly maxOutputChars: number;
	private readonly approvalManager?: ApprovalManager;

	constructor(options: InstallDependencyToolOptions = {}) {
		this.rootDir = options.rootDir;
		this.defaultTimeoutSec = options.timeoutSec ?? 120;
		this.maxOutputChars = options.maxOutputChars ?? 32_000;
		this.approvalManager = options.approvalManager;
	}

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					manager: {
						type: "string",
						enum: [...ALL_MANAGERS],
						description: "Package manager to use. Auto-detect when omitted.",
					},
					packages: {
						type: "array",
						items: { type: "string" },
						description: "Package specifiers (e.g. \"requests==2.32.3\", \"lodash\").",
					},
					dev: {
						type: "boolean",
						description: "Install as dev dependency. Default false.",
					},
					cwd: {
						type: "string",
						description: "Project subdirectory. Must stay inside project root.",
					},
					allowScripts: {
						type: "boolean",
						description: "Enable JS lifecycle scripts (postinstall etc). Default false. Raises risk to high.",
					},
					python: {
						type: "string",
						description: "Python interpreter for pip (default: python).",
					},
					requirementsPath: {
						type: "string",
						description: "pip only. Path to requirements file to update after install.",
					},
					runtimeOnly: {
						type: "boolean",
						description: "pip only. Install into current environment without manifest update.",
					},
					pipOptions: {
						type: "object",
						properties: {
							upgrade: { type: "boolean" },
							user: { type: "boolean" },
							noCacheDir: { type: "boolean" },
						},
						description: "pip only. Strict allowlist of extra flags.",
					},
					timeoutSec: {
						type: "integer",
						description: `Per-command timeout in seconds (default ${this.defaultTimeoutSec}, max 600).`,
					},
				},
				required: ["packages"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string; signal?: AbortSignal },
	): Promise<string> {
		const manager = this.resolveManager(args);
		if (!manager) return "Error: manager is required or could not be auto-detected. Specify one of: " + [...ALL_MANAGERS].join(", ");

		const packages = this.extractPackages(args.packages);
		if (!packages.length) return "Error: packages must be a non-empty array of strings";

		const dev = args.dev === true;
		const allowScripts = args.allowScripts === true;
		const timeoutSec = Math.max(1, Math.min(600, args.timeoutSec ?? this.defaultTimeoutSec));
		const cwd = this.resolveCwd(args.cwd, context?.workingDirectory);
		const python = typeof args.python === "string" && args.python.trim() ? args.python.trim() : "python";
		const requirementsPath = typeof args.requirementsPath === "string" ? args.requirementsPath : "";
		const runtimeOnly = args.runtimeOnly === true;
		const pipOptions = args.pipOptions && typeof args.pipOptions === "object" ? args.pipOptions : {};

		const validationError = this.validatePackages(manager, packages);
		if (validationError) return validationError;

		if (manager === "pip" && !runtimeOnly && !requirementsPath) {
			return "Error: pip requires either runtimeOnly=true or requirementsPath to be set. Use a manifest-based manager (uv, poetry, pipenv) for reproducible installs.";
		}

		const argv = buildInstallArgv(manager, packages, {
			dev, allowScripts, python, requirementsPath, pipOptions,
		});

		if (requirementsPath) {
			const reqAbs = pathMod.resolve(cwd, requirementsPath);
			if (!this.isInsideRoot(reqAbs, cwd)) {
				return `Error: requirementsPath "${requirementsPath}" escapes project root`;
			}
		}

		if (this.approvalManager) {
			const risk = assessInstallRisk(manager, { allowScripts, runtimeOnly, requirementsPath });
			const description = this.buildApprovalDescription(manager, packages, { dev, allowScripts, runtimeOnly, requirementsPath });
			const request = await this.approvalManager.requestApproval(
				this.name,
				{ manager, packages, dev, allowScripts, cwd },
				description,
			);
			const response = await this.approvalManager.checkApproval(request);
			if (!response.approved) {
				return `Error: dependency installation denied${response.reason ? ` — ${response.reason}` : ""}`;
			}
		}

		const result = await this.spawnProcess(argv, cwd, timeoutSec, context?.signal);

		let output = `$ ${argv.join(" ")}\n[exit ${result.exitCode ?? "?"}]`;
		if (result.stdout) output += `\n${result.stdout}`;
		if (result.stderr) output += `\n${result.stderr}`;

		if (result.exitCode === 0 && manager === "pip" && requirementsPath && packages.length) {
			const reqAbs = pathMod.resolve(cwd, requirementsPath);
			try {
				this.updateRequirementsFile(reqAbs, packages);
				output += `\n[updated ${requirementsPath}]`;
			} catch (err) {
				output += `\n[warning: failed to update ${requirementsPath}: ${err instanceof Error ? err.message : String(err)}]`;
			}
		}

		if (manager === "pip" && runtimeOnly) {
			output += "\n[info: installed into current Python environment only; no project manifest was updated]";
		}

		return truncateToolResult(output, this.maxOutputChars, "install_dependency");
	}

	private resolveManager(args: Record<string, any>): DependencyManager | null {
		const m = args.manager;
		if (typeof m === "string" && ALL_MANAGERS.has(m)) return m as DependencyManager;
		return null;
	}

	private extractPackages(raw: unknown): string[] {
		if (!Array.isArray(raw)) return [];
		return raw.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map(p => p.trim());
	}

	private validatePackages(manager: DependencyManager, packages: string[]): string | null {
		for (const pkg of packages) {
			if (DANGEROUS_PACKAGE_RE.test(pkg)) {
				return `Error: package "${pkg}" contains disallowed characters`;
			}
			if (PYTHON_MANAGERS.has(manager)) {
				if (PIP_URL_RE.test(pkg)) {
					return `Error: package "${pkg}" — URL/file/editable installs are not allowed. Use a direct package specifier.`;
				}
				const flagMatch = pkg.match(/^--?\S+/);
				if (flagMatch && PIP_FLAG_DENYLIST.has(flagMatch[0])) {
					return `Error: flag "${flagMatch[0]}" is not allowed in package specifiers`;
				}
			}
		}
		return null;
	}

	private resolveCwd(cwdArg: unknown, contextCwd?: string): string {
		const base = contextCwd || this.rootDir || process.cwd();
		if (typeof cwdArg !== "string" || !cwdArg.trim()) return base;
		const resolved = pathMod.resolve(base, cwdArg);
		if (!this.isInsideRoot(resolved, base)) return base;
		return resolved;
	}

	private isInsideRoot(target: string, root: string): boolean {
		const rel = pathMod.relative(root, target);
		return !rel.startsWith("..") && !pathMod.isAbsolute(rel);
	}

	private buildApprovalDescription(
		manager: DependencyManager,
		packages: string[],
		opts: { dev: boolean; allowScripts: boolean; runtimeOnly: boolean; requirementsPath: string },
	): string {
		const parts = [`Install ${packages.join(", ")} via ${manager}`];
		if (opts.dev) parts.push("(dev)");
		if (opts.allowScripts) parts.push("[scripts enabled — high risk]");
		if (opts.runtimeOnly) parts.push("[runtime-only — no manifest update]");
		if (opts.requirementsPath) parts.push(`[updates ${opts.requirementsPath}]`);
		return parts.join(" ");
	}

	private async spawnProcess(
		argv: string[],
		cwd: string,
		timeoutSec: number,
		signal?: AbortSignal,
	): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
		return new Promise((resolve) => {
			const [file, ...args] = argv;
			const spawnOpts: SpawnOptions = {
				cwd,
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			};
			const child = spawn(file!, args, spawnOpts);
			let stdout = "";
			let stderr = "";
			const maxChars = this.maxOutputChars;
			child.stdout?.on("data", (chunk: Buffer) => {
				if (stdout.length < maxChars) stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				if (stderr.length < maxChars) stderr += chunk.toString();
			});
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
			}, timeoutSec * 1000);
			if (signal) {
				signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
			}
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ exitCode: code, stdout: stdout.slice(0, maxChars), stderr: stderr.slice(0, maxChars) });
			});
			child.on("error", (err) => {
				clearTimeout(timer);
				resolve({ exitCode: -1, stdout, stderr: stderr + `\n${err.message}` });
			});
		});
	}

	private updateRequirementsFile(reqPath: string, packages: string[]): void {
		const existing = existsSync(reqPath) ? readFileSync(reqPath, "utf-8") : "";
		const lines = existing.split("\n");
		const updated = new Map<string, string>();
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) {
				updated.set(line, line);
				continue;
			}
			const nameMatch = trimmed.match(/^([A-Za-z0-9_-]+)/);
			if (nameMatch) updated.set(nameMatch[1]!.toLowerCase(), trimmed);
		}
		for (const pkg of packages) {
			const nameMatch = pkg.match(/^([A-Za-z0-9_-]+)/);
			if (nameMatch) updated.set(nameMatch[1]!.toLowerCase(), pkg);
		}
		const content = [...updated.values()].join("\n") + "\n";
		writeFileSync(reqPath, content, "utf-8");
	}
}

function buildInstallArgv(
	manager: DependencyManager,
	packages: string[],
	opts: {
		dev: boolean;
		allowScripts: boolean;
		python: string;
		requirementsPath: string;
		pipOptions: Record<string, any>;
	},
): string[] {
	switch (manager) {
		case "npm":
			return [
				"npm", "install",
				...(opts.dev ? ["-D"] : []),
				...packages,
				...(opts.allowScripts ? [] : ["--ignore-scripts"]),
			];
		case "pnpm":
			return [
				"pnpm", "add",
				...(opts.dev ? ["-D"] : []),
				...packages,
				...(opts.allowScripts ? [] : ["--ignore-scripts"]),
			];
		case "yarn":
			return [
				"yarn", "add",
				...(opts.dev ? ["-D"] : []),
				...packages,
				...(opts.allowScripts ? [] : ["--ignore-scripts"]),
			];
		case "bun":
			return [
				"bun", "add",
				...(opts.dev ? ["-d"] : []),
				...packages,
			];
		case "uv":
			return [
				"uv", "add",
				...(opts.dev ? ["--dev"] : []),
				...packages,
			];
		case "poetry":
			return [
				"poetry", "add",
				...(opts.dev ? ["--group", "dev"] : []),
				...packages,
			];
		case "pipenv":
			return [
				"pipenv", "install",
				...(opts.dev ? ["--dev"] : []),
				...packages,
			];
		case "pip": {
			return [
				opts.python, "-m", "pip", "install",
				...(opts.pipOptions.upgrade ? ["--upgrade"] : []),
				...(opts.pipOptions.user ? ["--user"] : []),
				...(opts.pipOptions.noCacheDir ? ["--no-cache-dir"] : []),
				...packages,
			];
		}
	}
}

function assessInstallRisk(
	manager: DependencyManager,
	opts: { allowScripts: boolean; runtimeOnly: boolean; requirementsPath: string },
): "low" | "medium" | "high" {
	if (opts.allowScripts) return "high";
	if (manager === "pip" && opts.runtimeOnly) return "medium";
	if (manager === "pip" && opts.requirementsPath) return "medium";
	return "medium";
}

export function dependencyWriteTargets(args: Record<string, unknown>, rootDir: string): string[] {
	const cwd = typeof args.cwd === "string" ? pathMod.resolve(rootDir, args.cwd) : rootDir;
	const manager = String(args.manager ?? "");
	const join = (p: string) => pathMod.join(cwd, p);

	switch (manager) {
		case "npm": return [join("package.json"), join("package-lock.json")];
		case "pnpm": return [join("package.json"), join("pnpm-lock.yaml")];
		case "yarn": return [join("package.json"), join("yarn.lock")];
		case "bun": return [join("package.json"), join("bun.lockb"), join("bun.lock")];
		case "uv": return [join("pyproject.toml"), join("uv.lock")];
		case "poetry": return [join("pyproject.toml"), join("poetry.lock")];
		case "pipenv": return [join("Pipfile"), join("Pipfile.lock")];
		case "pip": {
			const req = typeof args.requirementsPath === "string" ? args.requirementsPath : "";
			if (req) return [pathMod.resolve(cwd, req)];
			return [];
		}
		default: return [];
	}
}
