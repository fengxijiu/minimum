import { getPersona } from "../personas/PersonaRegistry.js";

export type ExecutionDepth = "fast" | "normal" | "deep";

const BUDGET_TABLE: Record<ExecutionDepth, { maxSteps: number; maxTokens: number }> = {
	fast: { maxSteps: 32, maxTokens: 24_000 },
	normal: { maxSteps: 64, maxTokens: 48_000 },
	deep: { maxSteps: 100, maxTokens: 96_000 },
};

export function resolveExecutionBudget(
	personaId: string,
	override?: ExecutionDepth,
): { maxSteps: number; maxTokens: number } {
	const depth = override ?? personaDefaultDepth(personaId);
	return BUDGET_TABLE[depth];
}

function personaDefaultDepth(personaId: string): ExecutionDepth {
	try {
		return getPersona(personaId).orchestration.executionDepth;
	} catch {
		return "normal";
	}
}
