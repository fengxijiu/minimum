import type { TaskDefinition, TaskQueueConfig, TaskStatus, TaskPriority, TaskUpdate, TaskHandler } from './types.js';

export class TaskQueue {
  private queue: TaskDefinition[] = [];
  private running: Map<string, TaskDefinition> = new Map();
  private completed: Map<string, TaskDefinition> = new Map();
  private handlers: Map<string, TaskHandler> = new Map();
  private config: TaskQueueConfig;
  private processing = false;
  private taskIdCounter = 0;

  constructor(config?: Partial<TaskQueueConfig>) {
    this.config = {
      maxConcurrent: config?.maxConcurrent || 3,
      maxRetries: config?.maxRetries || 3,
      retryDelay: config?.retryDelay || 1000,
      timeout: config?.timeout || 60000
    };
  }

  registerHandler(taskType: string, handler: TaskHandler): void {
    this.handlers.set(taskType, handler);
  }

  enqueue(name: string, description: string, payload: any, options?: {
    priority?: TaskPriority;
    dependencies?: string[];
    metadata?: Record<string, any>;
  }): TaskDefinition {
    const task: TaskDefinition = {
      id: `task_${++this.taskIdCounter}_${Date.now()}`,
      name,
      description,
      priority: options?.priority || 'medium',
      status: 'pending',
      payload,
      dependencies: options?.dependencies || [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: options?.metadata || {}
    };

    this.queue.push(task);
    this.sortQueue();
    this.processNext();

    return task;
  }

  private sortQueue(): void {
    const priorityOrder: Record<TaskPriority, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3
    };

    this.queue.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  }

  private async processNext(): Promise<void> {
    if (this.processing) return;
    if (this.running.size >= this.config.maxConcurrent) return;

    const taskIndex = this.queue.findIndex(task =>
      task.status === 'pending' &&
      task.dependencies.every(dep => this.completed.has(dep))
    );

    if (taskIndex === -1) return;

    const task = this.queue.splice(taskIndex, 1)[0];
    if (!task) return;

    task.status = 'running';
    task.startedAt = Date.now();
    task.updatedAt = Date.now();
    this.running.set(task.id, task);

    this.processing = true;
    await this.executeTask(task);
    this.processing = false;

    this.processNext();
  }

  private async executeTask(task: TaskDefinition): Promise<void> {
    const handler = this.handlers.get(task.name);

    if (!handler) {
      task.status = 'failed';
      task.error = `No handler registered for task type: ${task.name}`;
      task.completedAt = Date.now();
      task.updatedAt = Date.now();
      this.running.delete(task.id);
      this.completed.set(task.id, task);
      return;
    }

    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Task timeout')), this.config.timeout);
      });

      const resultPromise = handler(task);
      const result = await Promise.race([resultPromise, timeoutPromise]);

      task.status = 'completed';
      task.result = result;
      task.completedAt = Date.now();
      task.updatedAt = Date.now();
    } catch (error: any) {
      const retries = (task.metadata.retries || 0) as number;
      if (retries < this.config.maxRetries) {
        task.metadata.retries = retries + 1;
        task.status = 'pending';
        task.updatedAt = Date.now();
        this.queue.push(task);
        this.sortQueue();
        this.running.delete(task.id);
        return;
      }

      task.status = 'failed';
      task.error = error.message;
      task.completedAt = Date.now();
      task.updatedAt = Date.now();
    }

    this.running.delete(task.id);
    this.completed.set(task.id, task);
  }

  getTask(taskId: string): TaskDefinition | undefined {
    return this.queue.find(t => t.id === taskId) ||
           this.running.get(taskId) ||
           this.completed.get(taskId);
  }

  cancelTask(taskId: string): boolean {
    const queueIndex = this.queue.findIndex(t => t.id === taskId);
    if (queueIndex !== -1) {
      const task = this.queue[queueIndex];
      if (task) {
        task.status = 'cancelled';
        task.updatedAt = Date.now();
        this.queue.splice(queueIndex, 1);
      }
      return true;
    }

    const runningTask = this.running.get(taskId);
    if (runningTask) {
      runningTask.status = 'cancelled';
      runningTask.updatedAt = Date.now();
      this.running.delete(taskId);
      this.completed.set(taskId, runningTask);
      return true;
    }

    return false;
  }

  updateTask(taskId: string, update: TaskUpdate): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;

    if (update.status) task.status = update.status;
    if (update.result !== undefined) task.result = update.result;
    if (update.error) task.error = update.error;
    if (update.metadata) task.metadata = { ...task.metadata, ...update.metadata };
    task.updatedAt = Date.now();

    return true;
  }

  listTasks(filter?: { status?: TaskStatus; priority?: TaskPriority }): TaskDefinition[] {
    const allTasks = [
      ...this.queue,
      ...Array.from(this.running.values()),
      ...Array.from(this.completed.values())
    ];

    if (!filter) return allTasks;

    return allTasks.filter(task => {
      if (filter.status && task.status !== filter.status) return false;
      if (filter.priority && task.priority !== filter.priority) return false;
      return true;
    });
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getRunningCount(): number {
    return this.running.size;
  }

  getCompletedCount(): number {
    return this.completed.size;
  }

  clearCompleted(): void {
    this.completed.clear();
  }

  async waitForTask(taskId: string): Promise<TaskDefinition | undefined> {
    const task = this.getTask(taskId);
    if (!task) return undefined;

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return task;
    }

    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const currentTask = this.getTask(taskId);
        if (currentTask && (currentTask.status === 'completed' || currentTask.status === 'failed' || currentTask.status === 'cancelled')) {
          clearInterval(checkInterval);
          resolve(currentTask);
        }
      }, 100);
    });
  }
}
