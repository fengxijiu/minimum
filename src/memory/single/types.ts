import type { ChatMessage } from "../../types/common.js";

export type MemoryLayer = "session" | "project" | "global";

export type MemoryConfidence = "high" | "medium" | "low" | number;

export interface MemoryRecord {
	id: string;
	layer: MemoryLayer;
	scope: string;
	key: string;
	content: string;
	confidence: MemoryConfidence;
	source: string;
	updatedAt: string | number | Date;
	tags: string[];
	relatedFiles: string[];
}

export interface CurrentTask {
	input?: string;
	prompt?: string;
	content?: string;
	explicitPreferences?: string[];
}

export interface MemoryInjectionRequest {
	messages: readonly ChatMessage[];
	workingDirectory: string;
	userInput: string;
	turnIndex: number;
	maxTokens?: number;
	signal?: AbortSignal;
}

export interface MemoryInjectionResult {
	prelude: string;
	layers?: MemoryLayer[];
	metadata?: Record<string, unknown>;
}

export interface MemoryWritebackRequest {
	messages: readonly ChatMessage[];
	workingDirectory: string;
	userInput: string;
	turnIndex: number;
	totalCostUsd?: number;
	totalTokens?: number;
	toolCalls?: number;
	steps?: number;
	signal?: AbortSignal;
}

export interface ISingleAgentMemoryManager {
	buildPrelude(request: MemoryInjectionRequest): Promise<MemoryInjectionResult>;
	writeback(request: MemoryWritebackRequest): Promise<void>;
}
