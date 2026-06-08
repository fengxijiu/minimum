import { describe, expect, it } from "vitest";
import { classifyRoutePolicy } from "../../src/orchestration/RoutePolicy.js";
import { validateAgainstRoutePolicy } from "../../src/orchestration/RoutePolicyValidator.js";
import type { TaskContract } from "../../src/orchestration/TaskContract.js";

function contract(overrides: Partial<TaskContract> = {}): TaskContract {
	return {
		taskId: overrides.taskId ?? "T1",
		phase: overrides.phase ?? "P1",
		epicId: overrides.epicId ?? "audit",
		personaId: overrides.personaId ?? "reviewer",
		objective: overrides.objective ?? "review utils dead exports and MCP wiring",
		inputs: overrides.inputs ?? { userGoal: "audit", artifacts: [], constraints: [] },
		pathPolicy: overrides.pathPolicy ?? { allowedGlobs: ["src/utils/**", "src/mcp/**"], forbiddenGlobs: [] },
		acceptance: overrides.acceptance ?? ["dead exports", "MCP wiring", "docs stale", "TUI conflicts"],
		nonGoals: overrides.nonGoals ?? [],
		...(overrides.blockedCondition !== undefined && { blockedCondition: overrides.blockedCondition }),
		...(overrides.launchRequirements !== undefined && { launchRequirements: overrides.launchRequirements }),
		outputSchema: overrides.outputSchema ?? "task_report",
		parallelGroup: overrides.parallelGroup ?? "review",
		dependsOn: overrides.dependsOn ?? ["T0-1"],
		grantedSkills: overrides.grantedSkills ?? [],
		grantedMcpTools: overrides.grantedMcpTools ?? [],
		abortOnConflict: overrides.abortOnConflict ?? false,
	};
}

describe("RoutePolicyValidator", () => {
	it("flags audit_review large when reviewer fan-out is below the minimum", () => {
		const policy = classifyRoutePolicy("repo-wide dead code conflict audit", { route: "audit_review", scale: "large" });
		const issues = validateAgainstRoutePolicy({
			routePolicy: policy,
			contracts: [
				contract({ taskId: "T1" }),
				contract({ taskId: "D1", personaId: "docs", dependsOn: ["T1"], pathPolicy: { allowedGlobs: ["docs/**"], forbiddenGlobs: [] } }),
			],
		});

		expect(issues.map((i) => i.code)).toContain("audit_review_reviewer_under_fanout");
	});

	it("flags a broad reviewer that mixes multiple domains", () => {
		const policy = classifyRoutePolicy("audit dead code", { route: "audit_review", scale: "medium" });
		const issues = validateAgainstRoutePolicy({ routePolicy: policy, contracts: [contract({ taskId: "T1" })] });

		expect(issues.map((i) => i.code)).toContain("reviewer_scope_too_broad");
	});

	it("flags all reviewers hard-depending on the same scout file_list", () => {
		const policy = classifyRoutePolicy("audit dead code", { route: "audit_review", scale: "medium" });
		const reviewers = ["T1", "T2", "T3"].map((taskId) => contract({
			taskId,
			objective: `${taskId} scoped review`,
			acceptance: ["one domain"],
			pathPolicy: { allowedGlobs: [`src/${taskId}/**`], forbiddenGlobs: [] },
			launchRequirements: [{ sourceTaskId: "T0-1", artifact: "file_list", required: true }],
		}));

		const issues = validateAgainstRoutePolicy({ routePolicy: policy, contracts: reviewers });

		expect(issues.map((i) => i.code)).toContain("single_scout_file_list_bottleneck");
	});

	it("flags docs depending directly on repo_scout file_list", () => {
		const policy = classifyRoutePolicy("audit dead code", { route: "audit_review", scale: "medium" });
		const issues = validateAgainstRoutePolicy({
			routePolicy: policy,
			contracts: [
				contract({ taskId: "T0-1", personaId: "repo_scout", dependsOn: [], pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] } }),
				contract({
					taskId: "D1",
					personaId: "docs",
					dependsOn: ["T0-1"],
					pathPolicy: { allowedGlobs: ["docs/**"], forbiddenGlobs: [] },
					launchRequirements: [{ sourceTaskId: "T0-1", artifact: "file_list", required: true }],
				}),
			],
		});

		expect(issues.map((i) => i.code)).toContain("docs_depends_on_scout_file_list");
	});
});
