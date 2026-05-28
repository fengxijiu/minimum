import type {
	ErrorRecord,
	FixRecord,
	IIterationManager,
	IResultValidator,
	ITaskExecutor,
	IterationResult,
	IterationTask,
	TaskResult,
} from "../types/iteration.js";
import { ErrorRecorder } from "./ErrorRecorder.js";
import { FixRecorder } from "./FixRecorder.js";
import { RetryStrategy } from "./RetryStrategy.js";

export interface IterationManagerOptions {
	maxRetries?: number;
	backoffMs?: number;
	learnFromErrors?: boolean;
}

export class IterationManager implements IIterationManager {
	private errorRecorder: ErrorRecorder;
	private fixRecorder: FixRecorder;
	private retryStrategy: RetryStrategy;
	private learnFromErrors: boolean;

	constructor(options?: IterationManagerOptions) {
		this.errorRecorder = new ErrorRecorder();
		this.fixRecorder = new FixRecorder();
		this.retryStrategy = new RetryStrategy({
			maxRetries: options?.maxRetries,
			backoffMs: options?.backoffMs,
		});
		this.learnFromErrors = options?.learnFromErrors ?? true;
	}

	async execute(
		task: IterationTask,
		executor: ITaskExecutor,
		validator: IResultValidator,
	): Promise<IterationResult> {
		const startTime = Date.now();
		let lastResult: TaskResult | undefined;
		let lastError: ErrorRecord | undefined;

		for (
			let attempt = 0;
			attempt <= this.retryStrategy.getMaxRetries();
			attempt++
		) {
			try {
				// 执行任务
				const result = await executor.execute(task.initialContext, attempt);
				lastResult = result;

				// 验证结果
				const validation = await validator.validate(task, result);

				if (validation.passed) {
					// 成功
					if (attempt > 0 && this.learnFromErrors && lastError) {
						// 记录修复经验
						this.fixRecorder.record(
							task.id,
							lastError.message,
							"Retry with adjustments",
							lastResult?.content || "",
							result.content,
							true,
						);
					}

					return {
						taskId: task.id,
						success: true,
						result,
						attempts: attempt + 1,
						errorHistory: this.errorRecorder.getHistory(task.id),
						fixHistory: this.fixRecorder.getHistory(task.id),
						duration: Date.now() - startTime,
					};
				}

				// 验证失败，记录错误
				lastError = {
					attempt,
					message: validation.errors.join(", "),
					type: "validation",
					timestamp: Date.now(),
				};
				this.errorRecorder.record(
					task.id,
					new Error(lastError.message),
					attempt,
				);

				// 检查是否应该重试
				if (!this.retryStrategy.shouldRetry(attempt, lastError)) {
					break;
				}

				// 等待后重试
				if (attempt < this.retryStrategy.getMaxRetries()) {
					const delay = this.retryStrategy.getDelay(attempt);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			} catch (error) {
				// 执行错误
				lastError = {
					attempt,
					message: (error as Error).message,
					type: "execution",
					stack: (error as Error).stack,
					timestamp: Date.now(),
				};
				this.errorRecorder.record(task.id, error as Error, attempt);

				// 检查是否应该重试
				if (!this.retryStrategy.shouldRetry(attempt, lastError)) {
					break;
				}

				// 等待后重试
				if (attempt < this.retryStrategy.getMaxRetries()) {
					const delay = this.retryStrategy.getDelay(attempt);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		// 所有重试都失败
		return {
			taskId: task.id,
			success: false,
			result: lastResult,
			attempts: this.retryStrategy.getMaxRetries() + 1,
			errorHistory: this.errorRecorder.getHistory(task.id),
			fixHistory: this.fixRecorder.getHistory(task.id),
			duration: Date.now() - startTime,
		};
	}

	getErrorHistory(taskId: string): ErrorRecord[] {
		return this.errorRecorder.getHistory(taskId);
	}

	getFixHistory(taskId: string): FixRecord[] {
		return this.fixRecorder.getHistory(taskId);
	}

	findSimilarFixes(problem: string): FixRecord[] {
		return this.fixRecorder.findSimilarFixes(problem);
	}

	clearHistory(taskId?: string): void {
		this.errorRecorder.clearHistory(taskId);
		this.fixRecorder.clearHistory(taskId);
	}
}
