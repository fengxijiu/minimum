import { describe, expect, it } from "vitest";
import {
	classifyRoutePolicy,
	normalizeRouteHint,
	parseRouteHintFromInput,
	renderRoutePolicyForPlanner,
} from "../../src/orchestration/RoutePolicy.js";
import { classifyOrchestrationMode } from "../../src/orchestration/OrchestrationClassifier.js";
import {
	getPersona,
	registerPersonaForTesting,
	type Persona,
} from "../../src/personas/index.js";

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

	it("returns a defined taskCaps object for scan_only and full_pipeline routes", () => {
		const scanOnly = classifyRoutePolicy("explain how the router works");
		const fullPipeline = classifyRoutePolicy("do something across ambiguous modules");

		expect(scanOnly.route).toBe("scan_only");
		expect(scanOnly.taskCaps).toEqual({ repo_scout: { min: 1, max: 1 } });
		expect(fullPipeline.route).toBe("full_pipeline");
		expect(fullPipeline.taskCaps).toEqual({});
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

	it("ignores route or scale flags when the next token is another flag", () => {
		const parsed = parseRouteHintFromInput("--scale --route audit_review audit dead code");

		expect(parsed.cleanInput).toBe("audit dead code");
		expect(parsed.routeHint).toEqual({ route: "audit_review" });
		expect(() => normalizeRouteHint(parsed.routeHint)).not.toThrow();
	});

	it("keeps legacy orchestration modes backed by route policy classification", () => {
		expect(classifyOrchestrationMode("explain how the router works")).toBe("scan_only");
		expect(classifyOrchestrationMode("small patch the typo in README")).toBe("direct_edit");
		expect(classifyOrchestrationMode("audit dead code across the repo")).toBe("full_pipeline");
	});

	it("synthesizes route caps for newly registered personas with matching routeRoles", () => {
		const fake: Persona = {
			...getPersona("reviewer"),
			id: "contract_reviewer",
			systemPrompt: "Contract reviewer prompt",
			requiredReportBlocks: [],
			parallelism: { soloPerWave: false, maxConcurrent: 4 },
			orchestration: {
				stage: "review",
				routeRoles: ["audit_review"],
				chainRole: "review",
				executionDepth: "fast",
				planGate: "never",
				producesArtifacts: [],
				repairAliases: ["contract review"],
			},
		};
		const restore = registerPersonaForTesting(fake);
		try {
			const policy = classifyRoutePolicy("audit public contracts", {
				route: "audit_review",
				scale: "large",
			});
			expect(policy.taskCaps.contract_reviewer).toEqual({ min: 6, max: 10 });
			expect(policy.personaCaps.contract_reviewer).toBe(3);
		} finally {
			restore();
		}
	});

	it("does not fan out newly registered personas without routeRoles", () => {
		const fake: Persona = {
			...getPersona("reviewer"),
			id: "explicit_only_reviewer",
			systemPrompt: "Explicit reviewer prompt",
			requiredReportBlocks: [],
			orchestration: {
				stage: "review",
				routeRoles: [],
				chainRole: "review",
				executionDepth: "fast",
				planGate: "never",
				producesArtifacts: [],
				repairAliases: ["explicit reviewer"],
			},
		};
		const restore = registerPersonaForTesting(fake);
		try {
			const policy = classifyRoutePolicy("audit public contracts", {
				route: "audit_review",
				scale: "large",
			});
			expect(policy.taskCaps.explicit_only_reviewer).toBeUndefined();
			expect(policy.personaCaps.explicit_only_reviewer).toBeUndefined();
		} finally {
			restore();
		}
	});
});
