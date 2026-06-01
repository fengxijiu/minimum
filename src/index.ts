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
export { ExecShellTool } from "./tools/shell/index.js";

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
export { SessionMemory } from "./memory/SessionMemory.js";
export type { SessionData } from "./memory/SessionMemory.js";
export { ProjectMemory } from "./memory/ProjectMemory.js";
export type { ProjectMemoryEntry } from "./memory/ProjectMemory.js";
export { MemoryWriter, decideMemory } from "./memory/single/MemoryWriter.js";
export type { MemoryWriterOptions, MemoryWriteResult, WriteMemoryOptions } from "./memory/single/MemoryWriter.js";
export type { MemoryDecision } from "./memory/governance/types.js";
export {
	AppendOnlyLog,
	VolatileScratch,
	RuntimeMemory,
} from "./memory/RuntimeMemory.js";
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
export {
	SingleAgentMemoryManager,
	MemoryRetriever,
	MemoryResolver,
	MemoryPreludeBuilder,
	MemoryExtractor,
	SingleAgentMemoryScorer,
	MemoryWriter,
	MemoryCompactor,
} from "./memory/single/SingleAgentMemoryManager.js";
export type {
	SingleAgentMemoryManagerOptions,
	MemoryManagerRequest,
	MemoryScope,
	MemoryCandidate,
	ScoredMemory,
	ExtractedMemory,
	MemoryInjectionResult,
	MemoryWritebackResult,
} from "./memory/single/SingleAgentMemoryManager.js";

// Commands system
export { CommandRegistry, createDefaultRegistry } from "./commands/index.js";
export type {
	Command,
	CommandContext,
	CommandResult,
} from "./commands/index.js";
export {
	InitCommand,
	NewCommand,
	SaveCommand,
	LoadCommand,
	CompactCommand,
	UndoCommand,
	RedoCommand,
	SkillCommand,
	MemoryCommand,
	ConfigCommand,
	StatusCommand,
} from "./commands/index.js";

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

// Transcript system
export { TranscriptManager } from "./transcript/index.js";
export type {
	Transcript,
	TranscriptEntry,
	ReplayOptions,
} from "./transcript/index.js";

// Telemetry system
export { TelemetryManager } from "./telemetry/index.js";
export type { UsageStats, TurnStats, SessionStats } from "./telemetry/index.js";

// Skills system
export { Skill } from "./skills/Skill.js";
export type {
	SkillMetadata,
	SkillContext,
	SkillResult,
} from "./skills/Skill.js";
export { SkillRegistry } from "./skills/SkillRegistry.js";
export { SkillLoader } from "./skills/SkillLoader.js";
export type { SkillFile } from "./skills/SkillLoader.js";
export {
	CodeReviewSkill,
	RefactorSkill,
	TestGeneratorSkill,
	DocumentationSkill,
	registerBuiltinSkills,
} from "./skills/BuiltinSkills.js";

// Mocks — test-only, not exported in production build

// MCP (Model Context Protocol) support
export { McpClient, McpManager } from "./mcp/index.js";
export type {
	McpServerConfig,
	McpTool,
	McpResource,
	McpPrompt,
	McpRequest,
	McpResponse,
	McpToolCall,
	McpToolResult,
} from "./mcp/index.js";

// Sub-agent system
export { SubAgent, SubAgentManager } from "./subagent/index.js";
export type {
	SubAgentConfig,
	SubAgentState,
	SubAgentMessage,
} from "./subagent/index.js";

// Capacity controller
export { CapacityController } from "./capacity/index.js";
export type {
	CapacityConfig,
	CapacitySnapshot,
	CapacityObservation,
	RiskBand,
	GuardrailAction,
} from "./capacity/index.js";

// Task Manager
export { TaskQueue, TaskManager } from "./tasks/index.js";
export type {
	TaskDefinition,
	TaskQueueConfig,
	TaskStatus,
	TaskPriority,
	TaskUpdate,
	TaskHandler,
} from "./tasks/index.js";

// Semantic Index
export {
	SemanticIndex,
	Chunker,
	LocalEmbeddingProvider,
	OpenAIEmbeddingProvider,
} from "./index/index.js";
export type {
	IndexedDocument,
	SearchResult,
	IndexConfig,
	EmbeddingProvider,
	EmbeddingVector,
} from "./index/index.js";

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
