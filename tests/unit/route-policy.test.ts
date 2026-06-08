import { describe, expect, it } from "vitest";
import {
	classifyRoutePolicy,
	normalizeRouteHint,
	parseRouteHintFromInput,
	renderRoutePolicyForPlanner,
} from "../../src/orchestration/RoutePolicy.js";

describe("RoutePolicy", () => {
	it("classifies dead-code and conflict audits as audit_review large", () => {
		const policy = classifyRoutePolicy("review dead code and cross-module conflicts across the repo");

		expect(policy.route).toBe("audit_review");
		expect(policy.scale).toBe("large");
		expect(policy.taskCaps.reviewer?.min).toBe(6);
		expect(policy.taskCaps.reviewer?.max).toBe(10);
		expect(policy.granularityCaps.reviewerMaxDomains).toBe(1);
	});

	it("honors explicit route and fanout hints", () => {
		const policy = classifyRoutePolicy("check dead exports", {
			route: "audit_review",
			scale: "medium",
		});

		expect(policy.source).toBe("explicit");
		expect(policy.route).toBe("audit_review");
		expect(policy.scale).toBe("medium");
		expect(policy.taskCaps.reviewer?.min).toBe(3);
		expect(policy.taskCaps.reviewer?.max).toBe(5);
	});

	it("normalizes route hints and rejects unknown values", () => {
		expect(normalizeRouteHint({ route: "audit-review", scale: "large" })).toEqual({
			route: "audit_review",
			scale: "large",
		});
		expect(() => normalizeRouteHint({ route: "unknown", scale: "large" })).toThrow(/route/i);
		expect(() => normalizeRouteHint({ route: "audit_review", scale: "huge" })).toThrow(/scale/i);
	});

	it("renders planner policy text with caps and reasons", () => {
		const policy = classifyRoutePolicy("audit dead code", { route: "audit_review", scale: "large" });
		const text = renderRoutePolicyForPlanner(policy);

		expect(text).toContain("# Route Policy");
		expect(text).toContain("route: audit_review");
		expect(text).toContain("scale: large");
		expect(text).toContain("reviewer: 6-10");
		expect(text).toContain("repo_scout is a context probe");
	});

	it("extracts explicit route and fanout flags from user input", () => {
		const parsed = parseRouteHintFromInput("--route audit-review --fanout large audit dead code");

		expect(parsed.cleanInput).toBe("audit dead code");
		expect(parsed.routeHint).toEqual({ route: "audit-review", scale: "large" });
	});
});
