export type OrchestrationMode =
	| "single_agent"
	| "scan_only"
	| "direct_edit"
	| "full_pipeline";

const SCAN_KEYWORDS = ["解释", "分析", "查看", "为什么", "介绍", "是什么", "explain", "analyze", "describe", "what is", "how does"];
const EDIT_KEYWORDS = ["修改", "修复", "改一下", "fix", "bugfix", "patch", "hotfix"];
const PIPELINE_KEYWORDS = ["重构", "流水线", "多个模块", "完整", "并行", "验收", "refactor", "pipeline", "multi-module"];

export function classifyOrchestrationMode(userRequest: string): OrchestrationMode {
	const lower = userRequest.toLowerCase();

	if (PIPELINE_KEYWORDS.some((k) => lower.includes(k))) return "full_pipeline";

	const isScan = SCAN_KEYWORDS.some((k) => lower.includes(k));
	const isEdit = EDIT_KEYWORDS.some((k) => lower.includes(k));

	if (isScan && !isEdit) return "scan_only";
	if (isEdit && !isScan) return "direct_edit";

	return "full_pipeline";
}
