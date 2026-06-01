import type { ChatMessage } from "../../types/common.js";

export type MemoryLayer = "global" | "project" | "session";

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
