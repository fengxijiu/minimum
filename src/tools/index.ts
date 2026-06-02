export { ToolRegistry } from "./ToolRegistry.js";
export type { Tool, ToolCallContext } from "./ToolRegistry.js";
export type { ToolDefinition } from "../types/common.js";
export { TodoWriteTool } from "./todo/index.js";
export type { TodoItem, TodoStatus } from "./todo/index.js";
export { WebFetchTool } from "./web/index.js";
export {
	truncateToolResult,
	DEFAULT_MAX_RESULT_BYTES,
} from "./truncateResult.js";

// Wave 1 新增
export {
	ToolRateLimiter,
	normalizeToolRateLimitConfig,
	parseRateLimitedToolResult,
	DEFAULT_TOOL_RATE_LIMIT,
} from "./limits/index.js";
export type {
	ToolRateLimitConfig,
	ToolRateLimitBucketConfig,
	ToolRateLimitOption,
	NormalizedToolRateLimitConfig,
	NormalizedToolRateLimitBucket,
	ToolRateLimitDecision,
	RateLimitedToolResult,
} from "./limits/index.js";

export { ReadTracker } from "../loop/ReadTracker.js";

export {
	ChoiceTool,
	CancelledConfirmationGate,
	DeferredConfirmationGate,
} from "./choice/index.js";
export type {
	ConfirmationGate,
	ChoiceOption,
	ChoicePayload,
	ChoiceVerdict,
} from "./choice/index.js";

export {
	SymbolsTool,
	CodeQueryTool,
	grammarForPath,
	getParser,
	parseSource,
	setGrammarDir,
	extractSymbols,
	findInCode,
} from "./code-query/index.js";
export type {
	GrammarName,
	ParserOptions,
	CodeSymbol,
	SymbolKind,
	CodeMatch,
	CodeMatchKind,
	FindInCodeOptions,
} from "./code-query/index.js";
