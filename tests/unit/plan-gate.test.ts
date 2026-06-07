import { describe, expect, it } from "vitest";
import {
	compilePlanAudit,
	extractExecutionPlan,
	needsPlanApproval,
} from "../../src/orchestration/index.js";

describe("extractExecutionPlan", () => {
	it("pulls the <execution_plan> body", () => {
		const text = "noise\n<execution_plan>\nfiles_to_change:\n- a.ts\n</execution_plan>\ntail";
		expect(extractExecutionPlan(text)).toContain("files_to_change");
		expect(extractExecutionPlan(text)).toContain("a.ts");
	});
	it("returns empty string when absent", () => {
		expect(extractExecutionPlan("no plan here")).toBe("");
	});
});

describe("compilePlanAudit", () => {
	it("parses an APPROVED audit", () => {
		const r = compilePlanAudit('<plan_audit>{"decision":"APPROVED","corrections":[],"reason":"in scope"}</plan_audit>');
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.audit.decision).toBe("APPROVED");
			expect(r.audit.corrections).toEqual([]);
			expect(r.audit.reason).toBe("in scope");
		}
	});

	it("parses a REVISE audit with corrections", () => {
		const r = compilePlanAudit('<plan_audit>{"decision":"revise","corrections":["narrow to src/upload.ts"],"reason":"too broad"}</plan_audit>');
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.audit.decision).toBe("REVISE");
			expect(r.audit.corrections).toEqual(["narrow to src/upload.ts"]);
		}
	});

	it("rejects a missing block", () => {
		const r = compilePlanAudit("no audit");
		expect(r.ok).toBe(false);
	});

	it("rejects invalid JSON", () => {
		const r = compilePlanAudit("<plan_audit>{not json}</plan_audit>");
		expect(r.ok).toBe(false);
	});

	it("rejects an unknown decision", () => {
		const r = compilePlanAudit('<plan_audit>{"decision":"maybe"}</plan_audit>');
		expect(r.ok).toBe(false);
	});

	it("rejects a REVISE without corrections (unactionable)", () => {
		const r = compilePlanAudit('<plan_audit>{"decision":"REVISE","corrections":[],"reason":"x"}</plan_audit>');
		expect(r.ok).toBe(false);
	});
});

describe("needsPlanApproval", () => {
	it("is off when planMode is off", () => {
		expect(needsPlanApproval("code_executor", true, 1, undefined, "off")).toBe(false);
	});
	it("covers code_executor / test_writer under code_personas", () => {
		expect(needsPlanApproval("code_executor", true, 1, undefined, "code_personas")).toBe(true);
		expect(needsPlanApproval("test_writer", true, 1, undefined, "code_personas")).toBe(true);
	});
	it("excludes other write personas under code_personas", () => {
		expect(needsPlanApproval("docs", true, 1, undefined, "code_personas")).toBe(false);
	});
	it("covers any write persona under all_writes", () => {
		expect(needsPlanApproval("docs", true, 1, undefined, "all_writes")).toBe(true);
	});
	it("skips read-only personas and empty write scopes", () => {
		expect(needsPlanApproval("repo_scout", false, 0, undefined, "all_writes")).toBe(false);
		expect(needsPlanApproval("code_executor", true, 0, undefined, "code_personas")).toBe(false);
	});
	it("honours an explicit requiresPlanApproval flag", () => {
		expect(needsPlanApproval("docs", true, 1, true, "code_personas")).toBe(true);
	});
});
