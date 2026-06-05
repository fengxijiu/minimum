import type { ShellRule } from "./ShellTypes.js";

export const FS_READ_RULES: readonly ShellRule[] = [
	{
		id: "pwd",
		category: "fs_read",
		prefixes: ["pwd"],
		effect: "read_only",
		risk: "low",
	},
	{
		id: "ls",
		category: "fs_read",
		prefixes: ["ls", "dir"],
		effect: "read_only",
		risk: "low",
	},
	{
		id: "cat",
		category: "fs_read",
		prefixes: ["cat", "type"],
		effect: "read_only",
		risk: "low",
	},
	{
		id: "head-tail-wc-file-tree",
		category: "fs_read",
		prefixes: ["head", "tail", "wc", "file", "tree"],
		effect: "read_only",
		risk: "low",
		denyArgs: ["-o"],
	},
] as const;

export const SEARCH_RULES: readonly ShellRule[] = [
	{
		id: "grep",
		category: "search",
		prefixes: ["grep", "egrep", "fgrep"],
		effect: "read_only",
		risk: "low",
	},
	{
		id: "rg",
		category: "search",
		prefixes: ["rg"],
		effect: "read_only",
		risk: "low",
	},
	{
		id: "find-readonly",
		category: "search",
		prefixes: ["find"],
		effect: "read_only",
		risk: "low",
		denyArgs: [
			"-delete",
			"-exec",
			"-execdir",
			"-ok",
			"-okdir",
			"-fprint",
			"-fprint0",
			"-fprintf",
			"-fls",
		],
	},
] as const;

export const GIT_READ_RULES: readonly ShellRule[] = [
	{
		id: "git-status",
		category: "git_read",
		prefixes: ["git status"],
		effect: "read_only",
		risk: "low",
	},
	{
		id: "git-diff",
		category: "git_read",
		prefixes: ["git diff"],
		effect: "read_only",
		risk: "low",
		denyArgs: ["--output", "--ext-diff"],
	},
	{
		id: "git-log-show-blame",
		category: "git_read",
		prefixes: ["git log", "git show", "git blame"],
		effect: "read_only",
		risk: "low",
		denyArgs: ["--output"],
	},
	{
		id: "git-branch-read",
		category: "git_read",
		prefixes: ["git branch"],
		effect: "read_only",
		risk: "low",
		denyArgs: [
			"-d", "-D", "--delete",
			"-m", "-M", "--move",
			"-c", "-C", "--copy",
			"--force",
		],
	},
	{
		id: "git-remote-read",
		category: "git_read",
		prefixes: ["git remote"],
		effect: "read_only",
		risk: "low",
		denyArgs: ["add", "remove", "rm", "rename", "set-url", "set-head", "prune"],
	},
	{
		id: "git-rev-parse-config-get",
		category: "git_read",
		prefixes: ["git rev-parse", "git config --get", "git config --list"],
		effect: "read_only",
		risk: "low",
	},
] as const;

export const ENV_PROBE_RULES: readonly ShellRule[] = [
	{
		id: "tool-version-probe",
		category: "env_probe",
		prefixes: [
			"node --version", "node -v",
			"npm --version",
			"npx --version",
			"python --version", "python3 --version",
			"cargo --version",
			"go version",
			"rustc --version",
			"deno --version",
			"bun --version",
		],
		effect: "read_only",
		risk: "low",
	},
] as const;

export const TEST_RULES: readonly ShellRule[] = [
	{
		id: "test-runners",
		category: "test",
		prefixes: [
			"npm test", "npm run test",
			"npx vitest run", "npx vitest",
			"npx jest",
			"pytest", "python -m pytest",
			"cargo test",
			"go test",
			"deno test",
			"bun test",
		],
		effect: "starts_process",
		risk: "medium",
	},
] as const;

export const TYPECHECK_RULES: readonly ShellRule[] = [
	{
		id: "typecheck",
		category: "typecheck",
		prefixes: [
			"npm run typecheck", "npm run type-check",
			"npx tsc --noEmit", "tsc --noEmit",
			"mypy", "python -m mypy",
			"cargo check",
			"go vet",
			"ruff check",
			"pyright",
			"dart analyze",
		],
		effect: "starts_process",
		risk: "medium",
	},
] as const;

export const LINT_RULES: readonly ShellRule[] = [
	{
		id: "lint-check",
		category: "lint",
		prefixes: [
			"npm run lint",
			"npx eslint",
			"npx biome check",
			"npx prettier --check",
			"ruff",
			"flake8",
		],
		effect: "starts_process",
		risk: "medium",
		denyArgs: [
			"--fix", "--fix-dry-run",
			"--write", "--apply", "--apply-unsafe",
			"--unsafe-fixes",
			"format",
		],
	},
] as const;

export const BUILD_RULES: readonly ShellRule[] = [
	{
		id: "build",
		category: "build",
		prefixes: [
			"npm run build", "npm run compile",
			"pnpm run build", "yarn build", "bun run build",
			"cargo build", "cargo clippy",
			"go build",
			"mvn compile", "gradle compileJava",
			"dotnet build",
		],
		effect: "writes_workspace",
		risk: "medium",
	},
] as const;

export const ALL_SHELL_RULES: readonly ShellRule[] = [
	...FS_READ_RULES,
	...SEARCH_RULES,
	...GIT_READ_RULES,
	...ENV_PROBE_RULES,
	...TEST_RULES,
	...TYPECHECK_RULES,
	...LINT_RULES,
	...BUILD_RULES,
];
