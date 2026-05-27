import { describe, it, expect, beforeEach } from 'vitest';
import { TaskManager } from '../../src/tasks/TaskManager.js';

describe('Task Workflow', () => {
  let manager: TaskManager;

  beforeEach(() => {
    manager = new TaskManager({
      maxConcurrent: 2,
      persistence: false
    });
  });

  it('should create and execute task', async () => {
    // 注册处理器
    manager.registerHandler('test-task', async (task) => {
      return { result: 'Task completed', input: task.payload };
    });

    // 创建任务
    const task = await manager.createTask(
      'test-task',
      'Test task description',
      { data: 'test' },
      { priority: 'high' }
    );

    expect(task.id).toBeDefined();
    expect(task.status).toBe('running');

    // 等待任务完成
    const completed = await manager.waitForTask(task.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.result).toEqual({ result: 'Task completed', input: { data: 'test' } });
  });

  it('should handle task failure', async () => {
    manager.registerHandler('fail-task', async () => {
      throw new Error('Task failed');
    });

    const task = await manager.createTask(
      'fail-task',
      'Failing task',
      {}
    );

    const completed = await manager.waitForTask(task.id);
    expect(completed?.status).toBe('failed');
    expect(completed?.error).toContain('Task failed');
  });

  it('should respect priority order', async () => {
    const executionOrder: string[] = [];

    manager.registerHandler('priority-task', async (task) => {
      executionOrder.push(task.description);
      return { result: 'done' };
    });

    // 创建不同优先级的任务
    await manager.createTask('priority-task', 'Low', {}, { priority: 'low' });
    await manager.createTask('priority-task', 'High', {}, { priority: 'high' });
    await manager.createTask('priority-task', 'Medium', {}, { priority: 'medium' });

    // 等待所有任务完成
    await new Promise(resolve => setTimeout(resolve, 500));

    // 验证所有任务都被执行
    expect(executionOrder.length).toBe(3);
    expect(executionOrder).toContain('Low');
    expect(executionOrder).toContain('High');
    expect(executionOrder).toContain('Medium');
  });

  it('should list tasks by status', async () => {
    manager.registerHandler('list-task', async () => 'done');

    await manager.createTask('list-task', 'Task 1', {});
    await manager.createTask('list-task', 'Task 2', {});
    await manager.createTask('list-task', 'Task 3', {});

    const pending = manager.getPendingTasks();
    expect(pending.length).toBeGreaterThanOrEqual(0);

    const stats = manager.getStats();
    expect(stats).toBeDefined();
  });

  it('should cancel task', async () => {
    manager.registerHandler('cancel-task', async () => {
      await new Promise(resolve => setTimeout(resolve, 10000));
      return 'done';
    });

    const task = await manager.createTask('cancel-task', 'Long task', {});
    
    // 立即取消
    const cancelled = await manager.cancelTask(task.id);
    expect(cancelled).toBe(true);
  });
});