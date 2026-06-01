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

