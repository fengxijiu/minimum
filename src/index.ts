// Core types and interfaces
export * from "./types";
export * from "./utils";
export * from "./config";
export * from "./bridge";

// Core modules
export * from "./validators";
export * from "./repair";
export * from "./completeness";
export * from "./context";
export * from "./iteration";
export * from "./loop";

// Clients
export { MiMoClient } from "./clients/MiMoClient.js";
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
	GlobTool,
	ListDirectoryTool,
} from "./tools/filesystem/index.js";

// Shell tools
export { ExecShellTool } from "./tools/shell/index.js";

// Git tools
export {
	GitTool,
	GitStatusTool,
	GitDiffTool,
	GitLogTool,
} from "./tools/git/index.js";

// Search tools
export { GrepTool, SearchTool } from "./tools/search/index.js";

// Memory system
export { MemoryStore } from "./memory/MemoryStore.js";
export type { MemoryEntry, MemoryStoreOptions } from "./memory/MemoryStore.js";
export { SessionMemory } from "./memory/SessionMemory.js";
export type { SessionData } from "./memory/SessionMemory.js";
export { ProjectMemory } from "./memory/ProjectMemory.js";
export type { ProjectMemoryEntry } from "./memory/ProjectMemory.js";
export {
	AppendOnlyLog,
	VolatileScratch,
	RuntimeMemory,
} from "./memory/RuntimeMemory.js";

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
export type { Transcript, TranscriptEntry, ReplayOptions } from "./transcript/index.js";

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

// Mocks (单独导出避免冲突)
export { MockClient } from "./mocks/MockClient.js";
export { MockToolRegistry } from "./mocks/MockToolRegistry.js";
export { MockValidator } from "./mocks/MockValidator.js";
export { MockCompletenessChecker } from "./mocks/MockCompletenessChecker.js";
export { MockContextManager } from "./mocks/MockContextManager.js";
export { MockIterationManager } from "./mocks/MockIterationManager.js";
export { MockRepair } from "./mocks/MockRepair.js";

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
export type { SubAgentConfig, SubAgentState, SubAgentMessage } from "./subagent/index.js";

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
