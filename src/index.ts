// Core types and interfaces
export * from "./types/index.js";
export * from "./utils/index.js";
export * from "./config/index.js";
export * from "./bridge/index.js";

// Core modules
export * from "./validators/index.js";
export * from "./repair/index.js";
export * from "./completeness/index.js";
export * from "./context/index.js";
export * from "./iteration/index.js";
export * from "./loop/index.js";

// Clients
export { MiMoClient, resolveBaseUrl } from "./clients/MiMoClient.js";
export type {
	MiMoClientOptions,
	ChatOptions,
	ChatResponse,
} from "./clients/MiMoClient.js";

// Tools
export { ToolRegistry } from "./tools/ToolRegistry.js";
export type { Tool, ToolCallContext } from "./tools/ToolRegistry.js";

// File system tools
export {
	ReadFileTool,
	WriteFileTool,
	EditFileTool,
	ApplyPatchTool,
	GlobTool,
	ListDirectoryTool,
} from "./tools/filesystem/index.js";

// LSP / persistent diagnostics
export { getTsDiagnostics } from "./lsp/index.js";

// Shell tools
export {
	ExecShellTool,
	InstallDependencyTool,
	ShellCategoryTool,
	ShellFsReadTool,
	ShellSearchTool,
	ShellGitReadTool,
	ShellEnvProbeTool,
	ShellTestTool,
	ShellTypecheckTool,
	ShellLintTool,
	ShellBuildTool,
	ShellRawTool,
} from "./tools/shell/index.js";

// Git tools
export { GitTool } from "./tools/git/index.js";

// Search tools
export { GrepTool, SearchTool } from "./tools/search/index.js";

// Web tools
export { WebFetchTool } from "./tools/web/index.js";
export {
	truncateToolResult,
	DEFAULT_MAX_RESULT_BYTES,
} from "./tools/truncateResult.js";

// Todo tools
export { TodoWriteTool } from "./tools/todo/index.js";
export type { TodoItem, TodoStatus } from "./tools/todo/index.js";

// Memory system
export { MemoryStore } from "./memory/MemoryStore.js";
export type { MemoryEntry, MemoryStoreOptions } from "./memory/MemoryStore.js";
export { ProjectMemory } from "./memory/ProjectMemory.js";
export type { ProjectMemoryEntry } from "./memory/ProjectMemory.js";
export { MemoryWriter, decideMemory } from "./memory/single/MemoryWriter.js";
export type { MemoryWriterOptions, MemoryWriteResult, WriteMemoryOptions } from "./memory/single/MemoryWriter.js";
export type { MemoryDecision } from "./memory/governance/types.js";
export { extractCandidates } from "./memory/single/MemoryExtractor.js";
export type {
	ExtractedMemoryCandidate,
	ExtractedMemoryCategory,
	ExtractedMemoryLayer,
	MemoryExtractorContext,
} from "./memory/single/MemoryExtractor.js";
export {
	MemoryRetriever,
	retrieveMemory,
	extractKeywords,
	extractRecentFiles,
} from "./memory/single/index.js";
export type {
	MemoryLayer,
	MemoryMessage,
	MemoryRetrieverOptions,
	RetrievedMemory,
	RetrievedMemoryEntry,
	RetrieveMemoryQuery,
} from "./memory/single/index.js";
export { MemoryCompactor } from "./memory/single/MemoryCompactor.js";
export type {
	CompressionMetrics,
	CompressionReport,
	DeepCompressionDecision,
	MemoryCompactorOptions,
} from "./memory/single/MemoryCompactor.js";
export { SingleAgentMemoryManager } from "./memory/single/SingleAgentMemoryManager.js";
export type {
	SingleAgentMemoryManagerOptions,
	MemoryManagerRequest,
	MemoryScope,
	MemoryCandidate,
	ScoredMemory,
	ExtractedMemory,
} from "./memory/single/SingleAgentMemoryManager.js";

// Hooks system
export { HookManager } from "./hooks/index.js";
export type {
	Hook,
	HookConfig,
	HookContext,
	HookEvent,
	HookResult,
} from "./hooks/index.js";
export { HOOK_EVENTS } from "./hooks/index.js";

// Approval system
export { ApprovalManager } from "./approval/index.js";
export type {
	ApprovalRequest,
	ApprovalResponse,
	ApprovalConfig,
	ApprovalMode,
	RiskLevel,
} from "./approval/index.js";

// Session system
export { CheckpointManager, SessionManager } from "./session/index.js";
export type { Checkpoint, SessionState } from "./session/index.js";


// Skills system
export { Skill } from "./skills/Skill.js";
export type {
	SkillMetadata,
	SkillContext,
	SkillResult,
} from "./skills/Skill.js";
export { SkillRegistry } from "./skills/SkillRegistry.js";

export { loadLearnedSkills, loadLearnedSkillsSync } from "./skills/LearnedSkillLoader.js";
export type { LoadedLearnedSkill } from "./skills/LearnedSkillLoader.js";

export {
	LearnCommandService,
	LearnDraftStore,
	LearnSkillPromptLoader,
	LearnedSkillWriter,
	renderLearnedSkillMarkdown,
	titleFromSlug,
	toSkillSlug,
	validateLearnedSkillDraft,
	type LearnApplyResult,
	type LearnCommandServiceOptions,
	type LearnCreateRequest,
	type LearnCreateResult,
	type LearnedSkillDraft,
	type LearnedSkillDraftInput,
	type LearnMessage,
	type LearnPreviewResult,
	type LearnStatusResult,
} from "./learn/index.js";

export {
	PlanCommandService,
	PlanDraftStore,
	normalizePlanDraft,
	renderPlanDraftMarkdown,
	assertSafeDraftId,
} from "./plans/index.js";
export type {
	PlanDraft,
	PlanDraftStatus,
	PlanDraftStep,
	PlanDraftStepStatus,
	PlanImportResult,
	PlanPreviewResult,
	PlanStatusResult,
} from "./plans/index.js";

// Mocks — test-only, not exported in production build

// MCP (Model Context Protocol) support
export {
	McpClient,
	McpAuditLogger,
	McpCommandService,
	MinimumMcpServer,
	McpManager,
	McpToolAdapter,
	mcpToolName,
	readRecentAuditEvents,
	redactSecrets,
	summarizeArgs,
	startMinimumMcpServer,
	connectMcpServers,
	type ConnectMcpOptions,
	type ConnectMcpResult,
	type MinimumMcpServerOptions,
} from "./mcp/index.js";
export type {
	McpFailedServerDetails,
	McpListedPrompt,
	McpListedResource,
	McpServerDetails,
	McpServerConfig,
	McpTool,
	McpResource,
	McpPrompt,
	McpRequest,
	McpResponse,
	McpToolCall,
	McpToolResult,
} from "./mcp/index.js";


// Capacity controller
export { CapacityController } from "./capacity/index.js";
export type {
	CapacityConfig,
	CapacitySnapshot,
	CapacityObservation,
	RiskBand,
	GuardrailAction,
} from "./capacity/index.js";

export {
	MEMORY_PRELUDE_MARKER,
	buildPrelude,
	filterMemoryPreludeMessages,
	injectMemoryPreludeMessage,
	isMemoryPreludeMessage,
} from "./memory/single/MemoryPreludeBuilder.js";
export type {
	IncludedMemoryRecord,
	MemoryPreludeRequest,
	MemoryPreludeResult,
} from "./memory/single/MemoryPreludeBuilder.js";
export {
	scoreCandidate,
	shouldInject,
	shouldWrite,
} from "./memory/single/index.js";
export type {
	SingleAgentMemoryCandidate,
	SingleAgentMemoryRecord,
	SingleAgentMemoryScope,
	SingleAgentMemoryScore,
} from "./memory/single/index.js";
