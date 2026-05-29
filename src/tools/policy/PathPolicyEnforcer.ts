import * as path from "node:path";
import type { Persona } from "../../personas/Persona.js";
import type { TaskContract } from "../../orchestration/TaskContract.js";

/**
 * PathPolicyEnforcer — single point of truth for "may this persona write here?"
 *
 * The enforcer is invoked by every write-capable tool (WriteFile, EditFile,
 * ApplyPatch) before any disk side-effect. Personas with `canWrite: false`
 * are denied without inspecting paths; otherwise the path must match the
 * union of `persona.alwaysAllowedGlobs ∪ contract.allowedGlobs` and miss
 * the union of `persona.forbiddenGlobs ∪ contract.forbiddenGlobs`.
 *
 * Why not punt to operating-system permissions: the orchestrator runs as a
 * single Unix user; the per-persona isolation is purely policy-level. This
 * file is the policy.
 */

export type PathDecision =
	| { ok: true }
	| { ok: false; reason: PathDenyReason; code: PathDenyCode };

export type PathDenyCode =
	| "PERSONA_READ_ONLY"
	| "FORBIDDEN_PATH"
	| "NOT_IN_ALLOWED_GLOBS"
	| "ABSOLUTE_PATH"
	| "PATH_TRAVERSAL";

export type PathDenyReason = string;

export interface PolicyContext {
	persona: Persona;
	contract?: TaskContract;
	/** Project root the path is resolved against. */
	projectRoot: string;
}

/**
 * Normalize a path to a forward-slash, posix-normalized relative form. Shared
 * with ContextPackBuilder so memory ranking matches the write-policy gate.
 */
export function normalizeRelPath(p: string): string {
	return path.posix.normalize(p.replace(/\\/g, "/"));
}

export function checkWrite(
	targetPath: string,
	ctx: PolicyContext,
): PathDecision {
	// Hard rejects first: read-only personas never write.
	if (!ctx.persona.pathPolicy.canWrite) {
		return deny(
			"PERSONA_READ_ONLY",
			`persona ${ctx.persona.id} is read-only`,
		);
	}

	if (path.isAbsolute(targetPath)) {
		// Allow only when inside project root.
		const rel = path.relative(ctx.projectRoot, targetPath);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			return deny(
				"ABSOLUTE_PATH",
				`absolute path outside project root: ${targetPath}`,
			);
		}
		targetPath = rel;
	}

	// Normalize and reject parent traversal.
	const normalized = normalizeRelPath(targetPath);
	if (normalized.startsWith("..") || normalized.includes("/../")) {
		return deny(
			"PATH_TRAVERSAL",
			`path traversal detected: ${targetPath}`,
		);
	}

	// Forbidden union wins over allowed.
	const forbidden = mergeGlobs(
		ctx.persona.pathPolicy.forbiddenGlobs,
		ctx.contract?.pathPolicy.forbiddenGlobs ?? [],
	);
	for (const glob of forbidden) {
		if (matchGlob(normalized, glob)) {
			return deny(
				"FORBIDDEN_PATH",
				`path ${normalized} matches forbidden glob ${glob}`,
			);
		}
	}

	const allowed = mergeGlobs(
		ctx.persona.pathPolicy.alwaysAllowedGlobs,
		ctx.contract?.pathPolicy.allowedGlobs ?? [],
	);

	for (const glob of allowed) {
		if (matchGlob(normalized, glob)) return { ok: true };
	}

	return deny(
		"NOT_IN_ALLOWED_GLOBS",
		`path ${normalized} matches no allowed glob (persona=${ctx.persona.id}, taskId=${ctx.contract?.taskId ?? "n/a"})`,
	);
}

function deny(code: PathDenyCode, reason: string): PathDecision {
	return { ok: false, code, reason };
}

function mergeGlobs(a: string[], b: string[]): string[] {
	const out = new Set<string>();
	for (const g of a) out.add(g);
	for (const g of b) out.add(g);
	return [...out];
}

/**
 * Tiny glob matcher covering the subset we use:
 *  - `*`        — match any chars except `/`
 *  - `**`       — match any chars including `/`
 *  - literal segments and `.`, `_`, `-`
 *
 * This avoids pulling in `minimatch` for ~10 patterns per persona. The unit
 * tests pin the exact patterns the orchestrator generates, so divergence
 * from `minimatch` semantics in edge cases is acceptable.
 */
export function matchGlob(pathStr: string, glob: string): boolean {
	const re = globToRegExp(glob);
	return re.test(pathStr);
}

function globToRegExp(glob: string): RegExp {
	let re = "^";
	let i = 0;
	while (i < glob.length) {
		const ch = glob[i]!;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i += 2;
				// Eat following `/` since `**/x` and `**x` both mean any-depth.
				if (glob[i] === "/") i++;
			} else {
				re += "[^/]*";
				i++;
			}
		} else if (ch === "?") {
			re += "[^/]";
			i++;
		} else if (/[.+^$()|{}\[\]\\]/.test(ch)) {
			re += "\\" + ch;
			i++;
		} else {
			re += ch;
			i++;
		}
	}
	re += "$";
	return new RegExp(re);
}
