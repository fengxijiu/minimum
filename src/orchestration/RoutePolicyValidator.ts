import type { RoutePolicy } from "./RoutePolicy.js";
import type { CoarseDag, TaskContract } from "./TaskContract.js";
import { getPersona } from "../personas/PersonaRegistry.js";

export interface RoutePolicyIssue {
	code:
		| "audit_review_reviewer_under_fanout"
		| "audit_review_reviewer_over_fanout"
		| "reviewer_scope_too_broad"
		| "single_scout_file_list_bottleneck"
		| "docs_depends_on_scout_file_list";
	taskId?: string;
	message: string;
}

export function validateAgainstRoutePolicy(input: {
	routePolicy: RoutePolicy;
	contracts: TaskContract[];
	dag?: CoarseDag;
}): RoutePolicyIssue[] {
	const { routePolicy, contracts } = input;
	if (routePolicy.route !== "audit_review") return [];

	const issues: RoutePolicyIssue[] = [];
	const reviewers = contracts.filter((c) => personaChainRole(c) === "review");
	const reviewerCap = routePolicy.taskCaps.reviewer;
	if (reviewerCap && reviewers.length < reviewerCap.min) {
		issues.push({
			code: "audit_review_reviewer_under_fanout",
			message: `audit_review ${routePolicy.scale} requires ${reviewerCap.min}-${reviewerCap.max} reviewers, got ${reviewers.length}`,
		});
	}
	if (reviewerCap && reviewers.length > reviewerCap.max) {
		issues.push({
			code: "audit_review_reviewer_over_fanout",
			message: `audit_review ${routePolicy.scale} allows at most ${reviewerCap.max} reviewers, got ${reviewers.length}`,
		});
	}

	for (const reviewer of reviewers) {
		if (isBroadReviewer(reviewer, routePolicy)) {
			issues.push({
				code: "reviewer_scope_too_broad",
				taskId: reviewer.taskId,
				message: `${reviewer.taskId} mixes multiple finding domains or unrelated file clusters; split by domain or bounded file cluster`,
			});
		}
	}

	if (reviewers.length >= 2 && reviewers.every((r) => requiresSameScoutFileList(r, reviewers[0]!))) {
		issues.push({
			code: "single_scout_file_list_bottleneck",
			message: "all audit reviewers hard-depend on the same repo_scout.file_list; use scoped scouts or optional requirements for known file clusters",
		});
	}

	for (const docs of contracts.filter((c) => personaChainRole(c) === "document")) {
		const dependsOnScout = docs.dependsOn.some((dep) => personaChainRole(contracts.find((c) => c.taskId === dep)) === "discover");
		const requiresScoutFileList = (docs.launchRequirements ?? []).some(
			(req) => req.artifact === "file_list" && personaChainRole(contracts.find((c) => c.taskId === req.sourceTaskId)) === "discover",
		);
		if (dependsOnScout || requiresScoutFileList) {
			issues.push({
				code: "docs_depends_on_scout_file_list",
				taskId: docs.taskId,
				message: `${docs.taskId} should depend on reviewer task_report outputs, not repo_scout.file_list`,
			});
		}
	}

	return issues;
}

function personaChainRole(contract: TaskContract | undefined): string | undefined {
	if (!contract) return undefined;
	try {
		return getPersona(contract.personaId).orchestration.chainRole;
	} catch {
		return undefined;
	}
}

function isBroadReviewer(contract: TaskContract, policy: RoutePolicy): boolean {
	const objective = contract.objective.toLowerCase();
	const domainMatches = [
		/dead|unused|冗余/,
		/conflict|冲突/,
		/mcp/,
		/tui|frontend|ui/,
		/docs?|report|stale/,
		/barrel|export/,
		/security|安全/,
	].filter((re) => re.test(objective) || contract.acceptance.some((a) => re.test(a.toLowerCase()))).length;
	const rootDirs = new Set(
		contract.pathPolicy.allowedGlobs
			.map((glob) => glob.replace(/\\/g, "/").split("/")[0])
			.filter(Boolean),
	);
	return domainMatches > policy.granularityCaps.reviewerMaxDomains || rootDirs.size > 1 || contract.acceptance.length > 3;
}

function requiresSameScoutFileList(contract: TaskContract, first: TaskContract): boolean {
	const req = (contract.launchRequirements ?? []).find((r) => r.artifact === "file_list" && r.required !== false);
	const firstReq = (first.launchRequirements ?? []).find((r) => r.artifact === "file_list" && r.required !== false);
	return req !== undefined && firstReq !== undefined && req.sourceTaskId === firstReq.sourceTaskId;
}
