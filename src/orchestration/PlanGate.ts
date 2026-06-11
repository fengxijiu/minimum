import { extractXmlBlock } from "./TaskRunner.js";
import { getPersona } from "../personas/PersonaRegistry.js";

/**
 * PlanGate — pure parsing helpers for the W2-plan gate, where a write-capable
 * worker proposes an <execution_plan> and master_planner audits it via a
 * <plan_audit> block before the worker is allowed to execute.
 *
 * Kept dependency-free so the parsing is unit-testable without driving an LLM.
 */

export type PlanDecision = "APPROVED" | "REVISE";

export interface PlanAudit {
	decision: PlanDecision;
	/** Concrete fixes the worker must apply when REVISE. Empty when APPROVED. */
	corrections: string[];
	/** Short human-readable rationale. */
	reason: string;
}

export type PlanAuditResult =
	| { ok: true; audit: PlanAudit }
	| { ok: false; error: string };

/** Extract the worker's proposed plan from its turn output. */
export function extractExecutionPlan(text: string): string {
	return extractXmlBlock(text, "execution_plan").trim();
}

/**
 * Parse a master_planner <plan_audit> block:
 *
 *   <plan_audit>
 *   { "decision": "APPROVED" | "REVISE",
 *     "corrections": ["..."],
 *     "reason": "..." }
 *   </plan_audit>
 */
export function compilePlanAudit(text: string): PlanAuditResult {
	const block = extractXmlBlock(text, "plan_audit").trim();
	if (!block) return { ok: false, error: "missing <plan_audit> block" };

	let parsed: unknown;
	try {
		parsed = JSON.parse(block);
	} catch (e) {
		return { ok: false, error: `invalid JSON in <plan_audit>: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { ok: false, error: "<plan_audit> must be a JSON object" };
	}

	const raw = parsed as Record<string, unknown>;
	const decision = String(raw.decision ?? "").trim().toUpperCase();
	if (decision !== "APPROVED" && decision !== "REVISE") {
		return { ok: false, error: `decision must be APPROVED or REVISE (got ${JSON.stringify(raw.decision)})` };
	}
	const corrections = Array.isArray(raw.corrections)
		? raw.corrections.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
		: [];
	const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";

	// A REVISE with no concrete corrections is unactionable — reject as malformed.
	if (decision === "REVISE" && corrections.length === 0) {
		return { ok: false, error: "REVISE audit must include at least one correction" };
	}

	return { ok: true, audit: { decision: decision as PlanDecision, corrections, reason } };
}

/** Whether a task should pass through the plan gate for a given planMode. */
export function needsPlanApproval(
	personaId: string,
	canWrite: boolean,
	allowedGlobsCount: number,
	requiresPlanApproval: boolean | undefined,
	planMode: PlanMode,
): boolean {
	if (planMode === "off") return false;
	// A task with nothing writable has nothing to plan.
	if (!canWrite || allowedGlobsCount === 0) return false;
	if (requiresPlanApproval === true) return true;
	if (planMode === "all_writes") return true;
	if (planMode === "code_personas") {
		try {
			return getPersona(personaId).orchestration.planGate === "code_personas";
		} catch {
			return false;
		}
	}
	return false;
}

export type PlanMode = "off" | "code_personas" | "all_writes";
