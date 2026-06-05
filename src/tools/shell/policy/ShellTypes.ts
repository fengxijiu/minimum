import type { RiskLevel } from "../../../approval/types.js";

export type ShellCategory =
	| "fs_read"
	| "search"
	| "git_read"
	| "env_probe"
	| "test"
	| "typecheck"
	| "lint"
	| "build"
	| "raw"
	| "blocked";

export type ShellEffect =
	| "read_only"
	| "writes_workspace"
	| "writes_dependency_manifest"
	| "starts_process"
	| "network"
	| "unknown";

export type ShellDenyCode =
	| "EMPTY_COMMAND"
	| "PARSE_ERROR"
	| "UNKNOWN_COMMAND"
	| "CATEGORY_MISMATCH"
	| "RISKY_ARG"
	| "SENSITIVE_PATH"
	| "REDIRECT_OUTSIDE_WORKSPACE"
	| "REDIRECT_TO_SENSITIVE_PATH"
	| "UNSUPPORTED_SYNTAX"
	| "RAW_DISABLED";

export interface ShellPolicyDecision {
	ok: boolean;
	command: string;
	normalizedCommand: string;
	argv: string[];

	category: ShellCategory;
	effect: ShellEffect;
	risk: RiskLevel;

	matchedRule?: string;
	reason?: string;
	denyCode?: ShellDenyCode;

	touchesSensitivePath: boolean;
	usesRedirect: boolean;
	redirectWrites: boolean;
	redirectTargets: string[];

	requiresApproval: boolean;
}

export interface ShellClassifyOptions {
	cwd: string;
	allowedCategories: readonly ShellCategory[];
	extraAllowed?: readonly string[];
	rawEnabled?: boolean;
	sensitivePathMode?: "approval" | "deny";
}

export interface ShellRule {
	id: string;
	category: ShellCategory;
	prefixes: readonly string[];
	effect: ShellEffect;
	risk: RiskLevel;
	denyArgs?: readonly string[];
}
