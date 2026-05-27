export interface IterationTask {
	id: string;
	description: string;
	initialContext: any;
	maxRetries?: number;
	timeout?: number;
}

export interface TaskResult {
	content: string;
	success: boolean;
	code?: string;
	actions?: any[];
	metadata?: Record<string, any>;
}

export interface IterationResult {
	taskId: string;
	success: boolean;
	result?: TaskResult;
	attempts: number;
	errorHistory: any[];
	fixHistory: any[];
	duration: number;
}

export class MockIterationManager {
	private mockResult: IterationResult;

	constructor() {
		this.mockResult = {
			taskId: "mock-task",
			success: true,
			result: {
				content: "Mock result",
				success: true,
			},
			attempts: 1,
			errorHistory: [],
			fixHistory: [],
			duration: 100,
		};
	}

	setResult(result: IterationResult): void {
		this.mockResult = result;
	}

	async execute(
		task: IterationTask,
		executor: any,
		validator: any,
	): Promise<IterationResult> {
		return { ...this.mockResult, taskId: task.id };
	}

	getErrorHistory(taskId: string): any[] {
		return [];
	}

	getFixHistory(taskId: string): any[] {
		return [];
	}

	findSimilarFixes(problem: string): any[] {
		return [];
	}

	clearHistory(taskId?: string): void {
		// Mock: no-op
	}
}
