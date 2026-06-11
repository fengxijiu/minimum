import type {
	CheckerType,
	FailureSeverity,
	FailurePolicyAction,
} from "./types.js";

export interface PolicyContext {
	checkerType: CheckerType;
	severity: FailureSeverity;
	hasWorktree: boolean;
	isPathPolicyViolation: boolean;
	isForbiddenGlob: boolean;
}

export function resolveFailurePolicy(ctx: PolicyContext): FailurePolicyAction {
	if (ctx.isPathPolicyViolation || ctx.isForbiddenGlob) {
		return "terminate";
	}

	if (ctx.severity === "warning") {
		return "feedback_only";
	}

	if (ctx.severity === "blocking") {
		return ctx.hasWorktree ? "retain_and_repair" : "rollback_with_diff";
	}

	switch (ctx.checkerType) {
		case "syntax":
		case "typecheck":
		case "test":
		case "build":
			return ctx.hasWorktree ? "retain_and_repair" : "rollback_with_diff";

		case "pattern":
			return ctx.hasWorktree ? "retain_and_repair" : "rollback_with_diff";

		case "lint":
			return ctx.hasWorktree ? "retain_and_repair" : "rollback_with_diff";

		case "path_policy":
			return "terminate";

		case "custom":
			return ctx.hasWorktree ? "retain_and_repair" : "rollback_with_diff";

		default:
			return "rollback_with_diff";
	}
}
