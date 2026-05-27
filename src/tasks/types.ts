export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface TaskDefinition {
  id: string;
  name: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  payload: any;
  dependencies: string[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: any;
  error?: string;
  metadata: Record<string, any>;
}

export interface TaskQueueConfig {
  maxConcurrent: number;
  maxRetries: number;
  retryDelay: number;
  timeout: number;
}

export interface TaskUpdate {
  status?: TaskStatus;
  result?: any;
  error?: string;
  metadata?: Record<string, any>;
}

export type TaskHandler = (task: TaskDefinition) => Promise<any>;
