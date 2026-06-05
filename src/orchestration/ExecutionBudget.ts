export type ExecutionDepth = "fast" | "normal" | "deep";

const BUDGET_TABLE: Record<ExecutionDepth, { maxSteps: number; maxTokens: number }> = {
	fast: { maxSteps: 16, maxTokens: 24_000 },
	normal: { maxSteps: 40, maxTokens: 48_000 },
	deep: { maxSteps: 100, maxTokens: 96_000 },
};

const PERSONA_DEFAULT_DEPTH: Record<string, ExecutionDepth> = {
	master_planner: "normal",
	vision: "fast",
	repo_scout: "normal",
	web_searcher: "fast",
	context_builder: "fast",
	code_executor: "normal",
	test_writer: "normal",
	test_runner: "fast",
	runtime_debug: "deep",
	reviewer: "fast",
	docs: "fast",
};

export function resolveExecutionBudget(
	personaId: string,
	override?: ExecutionDepth,
): { maxSteps: number; maxTokens: number } {
	const depth = override ?? PERSONA_DEFAULT_DEPTH[personaId] ?? "normal";
	return BUDGET_TABLE[depth];
}
