import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TaskQueue } from "./TaskQueue.js";
import type {
	TaskDefinition,
	TaskHandler,
	TaskPriority,
	TaskStatus,
	TaskUpdate,
} from "./types.js";

export class TaskManager {
	private queue: TaskQueue;
	private basePath: string;
	private persistenceEnabled: boolean;

	constructor(options?: {
		basePath?: string;
		maxConcurrent?: number;
		maxRetries?: number;
		timeout?: number;
		persistence?: boolean;
	}) {
		// os.homedir() is cross-platform; $HOME alone is empty on Windows and
		// fell back to a literal "~" subdir of the cwd.
		this.basePath =
			options?.basePath ||
			path.join(os.homedir(), ".minimum", "tasks");
		this.persistenceEnabled = options?.persistence ?? true;

		this.queue = new TaskQueue({
			maxConcurrent: options?.maxConcurrent || 3,
			maxRetries: options?.maxRetries || 3,
			timeout: options?.timeout || 60000,
		});
	}

	async initialize(): Promise<void> {
		if (this.persistenceEnabled) {
			await fs.mkdir(this.basePath, { recursive: true });
			await this.loadTasks();
		}
	}

	registerHandler(taskType: string, handler: TaskHandler): void {
		this.queue.registerHandler(taskType, handler);
	}

	async createTask(
		name: string,
		description: string,
		payload: any,
		options?: {
			priority?: TaskPriority;
			dependencies?: string[];
			metadata?: Record<string, any>;
		},
	): Promise<TaskDefinition> {
		const task = this.queue.enqueue(name, description, payload, options);

		if (this.persistenceEnabled) {
			await this.saveTask(task);
		}

		return task;
	}

	getTask(taskId: string): TaskDefinition | undefined {
		return this.queue.getTask(taskId);
	}

	async cancelTask(taskId: string): Promise<boolean> {
		const success = this.queue.cancelTask(taskId);
		if (success && this.persistenceEnabled) {
			const task = this.queue.getTask(taskId);
			if (task) await this.saveTask(task);
		}
		return success;
	}

	async updateTask(taskId: string, update: TaskUpdate): Promise<boolean> {
		const success = this.queue.updateTask(taskId, update);
		if (success && this.persistenceEnabled) {
			const task = this.queue.getTask(taskId);
			if (task) await this.saveTask(task);
		}
		return success;
	}

	listTasks(filter?: {
		status?: TaskStatus;
		priority?: TaskPriority;
	}): TaskDefinition[] {
		return this.queue.listTasks(filter);
	}

	getPendingTasks(): TaskDefinition[] {
		return this.listTasks({ status: "pending" });
	}

	getRunningTasks(): TaskDefinition[] {
		return this.listTasks({ status: "running" });
	}

	getCompletedTasks(): TaskDefinition[] {
		return this.listTasks({ status: "completed" });
	}

	getFailedTasks(): TaskDefinition[] {
		return this.listTasks({ status: "failed" });
	}

	async waitForTask(taskId: string): Promise<TaskDefinition | undefined> {
		return this.queue.waitForTask(taskId);
	}

	getStats(): {
		pending: number;
		running: number;
		completed: number;
		failed: number;
		cancelled: number;
	} {
		const allTasks = this.listTasks();
		return {
			pending: allTasks.filter((t) => t.status === "pending").length,
			running: allTasks.filter((t) => t.status === "running").length,
			completed: allTasks.filter((t) => t.status === "completed").length,
			failed: allTasks.filter((t) => t.status === "failed").length,
			cancelled: allTasks.filter((t) => t.status === "cancelled").length,
		};
	}

	clearCompleted(): void {
		this.queue.clearCompleted();
	}

	private async saveTask(task: TaskDefinition): Promise<void> {
		try {
			const filePath = path.join(this.basePath, `${task.id}.json`);
			await fs.writeFile(filePath, JSON.stringify(task, null, 2));
		} catch (error) {
			console.error("Failed to save task:", error);
		}
	}

	private async loadTasks(): Promise<void> {
		try {
			const files = await fs.readdir(this.basePath);
			for (const file of files) {
				if (file.endsWith(".json")) {
					const content = await fs.readFile(
						path.join(this.basePath, file),
						"utf-8",
					);
					const task = JSON.parse(content) as TaskDefinition;
					if (task.status === "pending" || task.status === "running") {
						task.status = "pending";
						this.queue.enqueue(task.name, task.description, task.payload, {
							priority: task.priority,
							dependencies: task.dependencies,
							metadata: task.metadata,
						});
					}
				}
			}
		} catch {
			// Directory may not exist
		}
	}
}
