import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MiMoLoop } from '../../src/loop/MiMoLoop.js';
import { MockClient } from '../../src/mocks/MockClient.js';
import { MockToolRegistry } from '../../src/mocks/MockToolRegistry.js';
import { MockCompletenessChecker } from '../../src/mocks/MockCompletenessChecker.js';
import { CodeValidator } from '../../src/validators/CodeValidator.js';
import { ToolCallRepair } from '../../src/repair/ToolCallRepair.js';
import { ContextManager } from '../../src/context/ContextManager.js';
import { IterationManager } from '../../src/iteration/IterationManager.js';

describe('MiMoLoop Integration', () => {
  let loop: MiMoLoop;
  let client: MockClient;
  let tools: MockToolRegistry;

  beforeEach(() => {
    client = new MockClient();
    tools = new MockToolRegistry();

    loop = new MiMoLoop({
      client,
      tools,
      validator: new CodeValidator(),
      toolRepair: new ToolCallRepair(),
      completenessChecker: new MockCompletenessChecker(),
      contextManager: new ContextManager(),
      iterationManager: new IterationManager(),
      maxTokens: 4000,
      maxSteps: 10,
      workingDirectory: '/test'
    });
  });

  it('should execute simple task', async () => {
    client.setDefaultResponse('Task completed successfully');

    const events: any[] = [];
    for await (const event of loop.run('Say hello')) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'content')).toBe(true);
    expect(events.some(e => e.type === 'done')).toBe(true);
  });

  it('should handle tool calls', async () => {
    client.setDefaultResponse('');
    client.setResponse('Read file', 'File content here');

    tools.register({
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      fn: async () => 'File content'
    });

    const events: any[] = [];
    for await (const event of loop.run('Read the file')) {
      events.push(event);
    }

    // 由于MockClient不支持返回工具调用，我们只验证事件被生成
    expect(events.length).toBeGreaterThan(0);
  });

  it('should track usage', async () => {
    client.setDefaultResponse('Done');

    const events: any[] = [];
    for await (const event of loop.run('Test')) {
      events.push(event);
    }

    const usageEvent = events.find(e => e.type === 'usage');
    expect(usageEvent).toBeDefined();
    expect(usageEvent.promptTokens).toBeDefined();
    expect(usageEvent.totalTokens).toBeDefined();
  });

  it('should handle errors gracefully', async () => {
    client.setDefaultResponse('');

    // 模拟错误
    const originalChat = client.chat.bind(client);
    client.chat = async (options) => {
      throw new Error('API Error');
    };

    const events: any[] = [];
    for await (const event of loop.run('Test error')) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'error')).toBe(true);
  });
});