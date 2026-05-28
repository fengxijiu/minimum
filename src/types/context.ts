import type { ChatMessage } from "./common.js";

export interface TaskState {
	objective: string;
	currentStep: number;
	totalSteps?: number;
	completedSubtasks: string[];
	pendingSubtasks: string[];
}

export interface Decision {
	content: string;
	reason?: string;
	timestamp: number;
}

export interface FileChange {
	file: string;
	type: "create" | "modify" | "delete";
	description: string;
	diff?: string;
}

export interface ErrorInfo {
	message: string;
	type: string;
	resolved: boolean;
	solution?: string;
	timestamp: number;
}

export interface KeyInfo {
	taskObjective: string;
	decisions: Decision[];
	fileChanges: FileChange[];
	errors: ErrorInfo[];
	constraints: string[];
	partialResults: string[];
}

export interface ContextOptimizeRequest {
	messages: ChatMessage[];
	taskState: TaskState;
	maxTokens: number;
	currentTokens?: number;
	strategy?: "conservative" | "balanced" | "aggressive";
}

export interface ContextOptimizeResult {
	messages: ChatMessage[];
	folded: boolean;
	originalCount: number;
	foldedCount: number;
	retainedInfo: KeyInfo | null;
	summaryMessage?: ChatMessage;
	tokens: {
		before: number;
		after: number;
		saved: number;
	};
}

export interface IContextManager {
	optimize(request: ContextOptimizeRequest): Promise<ContextOptimizeResult>;
	extractKeyInfo(
		messages: ChatMessage[],
		taskState: TaskState,
	): Promise<KeyInfo>;
	generateSummary(messages: ChatMessage[], keyInfo: KeyInfo): Promise<string>;
	countTokens(messages: ChatMessage[]): number;
	shouldFold(currentTokens: number, maxTokens: number): boolean;
}
