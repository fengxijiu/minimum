import { tokenizeCommand, hasSensitivePathArgs } from "../parse.js";
import { parseCommandChain } from "../shell-chain.js";
import { ALL_SHELL_RULES } from "./ShellRules.js";
import type {
	ShellCategory,
	ShellClassifyOptions,
	ShellDenyCode,
	ShellEffect,
	ShellPolicyDecision,
	ShellRule,
} from "./ShellTypes.js";
import type { RiskLevel } from "../../../approval/types.js";

function deny(
	command: string,
	denyCode: ShellDenyCode,
	reason: string,
): ShellPolicyDecision {
	return {
		ok: false,
		command,
		normalizedCommand: command.trim(),
		argv: [],
		category: "blocked",
		effect: "unknown",
		risk: "high",
		denyCode,
		reason,
		touchesSensitivePath: false,
		usesRedirect: false,
		redirectWrites: false,
		redirectTargets: [],
		requiresApproval: false,
	};
}

function allow(opts: {
	command: string;
	normalizedCommand: string;
	argv: string[];
	category: ShellCategory;
	effect: ShellEffect;
	risk: RiskLevel;
	matchedRule?: string;
	touchesSensitivePath: boolean;
	usesRedirect: boolean;
	redirectWrites: boolean;
	redirectTargets: string[];
	requiresApproval: boolean;
}): ShellPolicyDecision {
	return {
		ok: true,
		command: opts.command,
		normalizedCommand: opts.normalizedCommand,
		argv: opts.argv,
		category: opts.category,
		effect: opts.effect,
		risk: opts.risk,
		matchedRule: opts.matchedRule,
		touchesSensitivePath: opts.touchesSensitivePath,
		usesRedirect: opts.usesRedirect,
		redirectWrites: opts.redirectWrites,
		redirectTargets: opts.redirectTargets,
		requiresApproval: opts.requiresApproval,
	};
}

function matchRule(
	argv: string[],
	command: string,
): { rule: ShellRule; matched: boolean } | null {
	const cmdLower = command.toLowerCase();
	for (const rule of ALL_SHELL_RULES) {
		for (const prefix of rule.prefixes) {
			const prefixLower = prefix.toLowerCase();
			if (
				cmdLower === prefixLower ||
				cmdLower.startsWith(prefixLower + " ")
			) {
				return { rule, matched: true };
			}
		}
	}
	return null;
}

function hasRiskyArg(argv: string[], denyArgs: readonly string[]): string | null {
	for (const token of argv) {
		const t = token.toLowerCase();
		for (const denied of denyArgs) {
			if (t === denied.toLowerCase()) return token;
			if (t.startsWith(denied.toLowerCase() + "=")) return token;
		}
	}
	return null;
}

function classifySegment(
	argv: string[],
	segmentStr: string,
	opts: ShellClassifyOptions,
): ShellPolicyDecision {
	const normalized = segmentStr.trim();
	if (!normalized) {
		return deny(normalized, "EMPTY_COMMAND", "empty command segment");
	}

	const match = matchRule(argv, normalized);
	if (!match) {
		if (opts.rawEnabled && opts.allowedCategories.includes("raw")) {
			return allow({
				command: normalized,
				normalizedCommand: normalized,
				argv,
				category: "raw",
				effect: "unknown",
				risk: "high",
				touchesSensitivePath: false,
				usesRedirect: false,
				redirectWrites: false,
				redirectTargets: [],
				requiresApproval: true,
			});
		}
		return deny(
			normalized,
			"UNKNOWN_COMMAND",
			`command not recognized: ${argv[0] ?? normalized}`,
		);
	}

	const { rule } = match;

	if (!opts.allowedCategories.includes(rule.category)) {
		return deny(
			normalized,
			"CATEGORY_MISMATCH",
			`command category "${rule.category}" is not allowed for this tool (allowed: ${opts.allowedCategories.join(", ")})`,
		);
	}

	if (rule.denyArgs) {
		const risky = hasRiskyArg(argv, rule.denyArgs);
		if (risky) {
			return deny(
				normalized,
				"RISKY_ARG",
				`risky argument "${risky}" is not allowed for ${rule.category} commands`,
			);
		}
	}

	let touchesSensitive = false;
	try {
		touchesSensitive = hasSensitivePathArgs(argv);
	} catch {
		// best-effort
	}

	if (touchesSensitive && opts.sensitivePathMode === "deny") {
		return deny(
			normalized,
			"SENSITIVE_PATH",
			"command touches sensitive paths and sensitivePathMode is deny",
		);
	}

	const requiresApproval =
		touchesSensitive ||
		rule.risk === "high" ||
		(rule.risk === "medium" && rule.effect !== "read_only");

	return allow({
		command: normalized,
		normalizedCommand: normalized,
		argv,
		category: rule.category,
		effect: rule.effect,
		risk: touchesSensitive ? "high" : rule.risk,
		matchedRule: rule.id,
		touchesSensitivePath: touchesSensitive,
		usesRedirect: false,
		redirectWrites: false,
		redirectTargets: [],
		requiresApproval,
	});
}

export function classifyCommand(
	command: string,
	opts: ShellClassifyOptions,
): ShellPolicyDecision {
	const trimmed = command.trim();
	if (!trimmed) {
		return deny(command, "EMPTY_COMMAND", "empty command");
	}

	let chain;
	try {
		chain = parseCommandChain(trimmed);
	} catch (err) {
		return deny(
			trimmed,
			"UNSUPPORTED_SYNTAX",
			String((err as Error).message),
		);
	}

	if (!chain) {
		let argv: string[];
		try {
			argv = tokenizeCommand(trimmed);
		} catch {
			return deny(trimmed, "PARSE_ERROR", "failed to tokenize command");
		}
		return classifySegment(argv, trimmed, opts);
	}

	const allRedirectTargets: string[] = [];
	let anyRedirectWrites = false;
	let lastDecision: ShellPolicyDecision | undefined;

	for (const segment of chain.segments) {
		const segDecision = classifySegment(
			segment.argv,
			segment.argv.join(" "),
			opts,
		);
		if (!segDecision.ok) return segDecision;
		lastDecision = segDecision;

		for (const redirect of segment.redirects) {
			if (redirect.target) {
				allRedirectTargets.push(redirect.target);
				if (redirect.kind === ">" || redirect.kind === ">>" || redirect.kind === "&>" || redirect.kind === "2>" || redirect.kind === "2>>") {
					anyRedirectWrites = true;
				}
			}
		}
	}

	if (!lastDecision) {
		return deny(trimmed, "PARSE_ERROR", "no segments in command chain");
	}

	if (anyRedirectWrites && lastDecision.risk === "low") {
		return allow({
			...lastDecision,
			command: trimmed,
			normalizedCommand: trimmed,
			risk: "medium",
			usesRedirect: true,
			redirectWrites: true,
			redirectTargets: allRedirectTargets,
			requiresApproval: true,
		});
	}

	return allow({
		...lastDecision,
		command: trimmed,
		normalizedCommand: trimmed,
		usesRedirect: allRedirectTargets.length > 0,
		redirectWrites: anyRedirectWrites,
		redirectTargets: allRedirectTargets,
	});
}
