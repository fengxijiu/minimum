import type { ChatMessage, ToolCall } from "./common";
export type { ToolCall };

interface TaskState {
	objective: string;
	currentStep: number;
	totalSteps?: number;
	completedSubtasks: string[];
	pendingSubtasks: string[];
}

export interface TaskContext {
	messages: ChatMessage[];
	systemPrompt?: string;
	tools?: any[];
	state?: TaskState;
}

export interface IterationTask {
	id: string;
	description: string;
	initialContext: TaskContext;
	maxRetries?: number;
	timeout?: number;
}

export interface TaskResult {
	content: string;
	success: boolean;
	code?: string;
	actions?: Action[];
	metadata?: Record<string, any>;
}

export interface Action {
	type: "file-read" | "file-write" | "shell-exec" | "tool-call";
	details: Record<string, any>;
	result: any;
	timestamp: number;
}

export interface ErrorRecord {
	attempt: number;
	message: string;
	type: "validation" | "execution" | "timeout" | "unknown";
	stack?: string;
	timestamp: number;
	toolCall?: ToolCall;
}

export interface FixRecord {
	problem: string;
	solution: string;
	before: string;
	after: string;
	timestamp: number;
	successful: boolean;
}

export interface IterationResult {
	taskId: string;
	success: boolean;
	result?: TaskResult;
	attempts: number;
	errorHistory: ErrorRecord[];
	fixHistory: FixRecord[];
	duration: number;
}

export interface ITaskExecutor {
	execute(context: TaskContext, attempt: number): Promise<TaskResult>;
}

export interface IResultValidator {
	validate(
		task: IterationTask,
		result: TaskResult,
	): Promise<{ passed: boolean; errors: string[] }>;
}

export interface IIterationManager {
	execute(
		task: IterationTask,
		executor: ITaskExecutor,
		validator: IResultValidator,
	): Promise<IterationResult>;
	getErrorHistory(taskId: string): ErrorRecord[];
	getFixHistory(taskId: string): FixRecord[];
	findSimilarFixes(problem: string): FixRecord[];
	clearHistory(taskId?: string): void;
}
