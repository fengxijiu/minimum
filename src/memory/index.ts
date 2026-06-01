export { MemoryStore } from "./MemoryStore.js";
export type { MemoryEntry, MemoryStoreOptions } from "./MemoryStore.js";

export { ProjectMemory } from "./ProjectMemory.js";
export type { ProjectMemoryEntry } from "./ProjectMemory.js";

export { resolveMemory } from "./single/index.js";
export type {
	CurrentTask,
	MemoryConfidence as SingleMemoryConfidence,
	MemoryRecord,
} from "./single/index.js";

export {
	getGlobalMemoryRoot,
	getMemoryFile,
	getMemoryIndexPath,
	getProjectMemoryRoot,
	globalMemoryLayer,
	projectMemoryLayer,
	sanitizeMemoryKey,
} from "./single/MemoryPaths.js";
export type {
	GlobalMemoryLayer,
	MemoryLayer,
	MemoryLayerScope,
	ProjectMemoryLayer,
} from "./single/MemoryPaths.js";

export {
	MEMORY_PRELUDE_MARKER,
	buildPrelude,
	filterMemoryPreludeMessages,
	injectMemoryPreludeMessage,
	isMemoryPreludeMessage,
} from "./single/MemoryPreludeBuilder.js";
export type {
	IncludedMemoryRecord,
	MemoryPreludeRequest,
	MemoryPreludeResult,
} from "./single/MemoryPreludeBuilder.js";

export {
	MemoryRetriever,
	retrieveMemory,
	extractKeywords,
	extractRecentFiles,
} from "./single/index.js";
export type {
	MemoryMessage,
	MemoryRetrieverOptions,
	RetrievedMemory,
	RetrievedMemoryEntry,
	RetrieveMemoryQuery,
} from "./single/index.js";

export { MemoryCompactor } from "./single/MemoryCompactor.js";
export type {
	CompressionMetrics,
	CompressionReport,
	DeepCompressionDecision,
	MemoryCompactorOptions,
} from "./single/MemoryCompactor.js";

export {
	scoreCandidate,
	shouldInject,
	shouldWrite,
} from "./single/index.js";
export type {
	SingleAgentMemoryCandidate,
	SingleAgentMemoryRecord,
	SingleAgentMemoryScope,
	SingleAgentMemoryScore,
} from "./single/index.js";

export { MemoryWriter, decideMemory } from "./single/MemoryWriter.js";
export type { MemoryWriterOptions, MemoryWriteResult, WriteMemoryOptions } from "./single/MemoryWriter.js";
export type { MemoryDecision } from "./governance/types.js";
