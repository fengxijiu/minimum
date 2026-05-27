import type { ChatMessage, ToolCall, ToolResult } from '../../src/types/common';
import type { ValidationRequest, ValidationResult } from '../../src/types/validator';
import type { CompletenessRequest, CompletenessResult } from '../../src/types/completeness';
import type { ContextOptimizeRequest } from '../../src/types/context';
import type { IterationTask } from '../../src/types/iteration';

/**
 * 创建模拟消息
 */
export function createMockMessage(role: string = 'user', content: string = 'test'): ChatMessage {
  return { role, content };
}

/**
 * 创建模拟工具调用
 */
export function createMockToolCall(name: string = 'test_tool', args: Record<string, any> = {}): ToolCall {
  return {
    id: `call_${Date.now()}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}

/**
 * 创建模拟工具结果
 */
export function createMockToolResult(content: string = 'success', isError: boolean = false): ToolResult {
  return { content, isError };
}

/**
 * 创建模拟验证请求
 */
export function createMockValidationRequest(toolName: string = 'test_tool'): ValidationRequest {
  return {
    toolName,
    toolArgs: { path: '/test/file.ts' },
    toolResult: { content: 'test content' }
  };
}

/**
 * 创建模拟验证结果
 */
export function createMockValidationResult(passed: boolean = true): ValidationResult {
  return {
    passed,
    checks: [{
      name: 'test-check',
      type: 'syntax',
      passed,
      message: passed ? 'Check passed' : 'Check failed',
      severity: passed ? 'info' : 'error'
    }],
    suggestions: passed ? [] : ['Fix the issue'],
    severity: passed ? 'info' : 'error'
  };
}

/**
 * 创建模拟完整性请求
 */
export function createMockCompletenessRequest(task: string = 'test task'): CompletenessRequest {
  return {
    task,
    generatedCode: 'function test() { return true; }',
    context: {
      projectRoot: '/test/project',
      readFiles: [],
      modifiedFiles: [],
      language: 'typescript'
    }
  };
}

/**
 * 创建模拟完整性结果
 */
export function createMockCompletenessResult(complete: boolean = true): CompletenessResult {
  return {
    complete,
    score: complete ? 100 : 50,
    issues: complete ? [] : [{
      type: 'missing-import',
      severity: 'warning',
      message: 'Missing import'
    }],
    suggestions: complete ? [] : ['Add missing import'],
    requiredActions: []
  };
}

/**
 * 创建模拟上下文优化请求
 */
export function createMockContextOptimizeRequest(): ContextOptimizeRequest {
  return {
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' }
    ],
    taskState: {
      objective: 'test objective',
      currentStep: 1,
      completedSubtasks: [],
      pendingSubtasks: []
    },
    maxTokens: 8000
  };
}

/**
 * 创建模拟迭代任务
 */
export function createMockIterationTask(): IterationTask {
  return {
    id: 'test-task-1',
    description: 'Test task',
    initialContext: {
      messages: [{ role: 'user', content: 'Test' }]
    },
    maxRetries: 3
  };
}

/**
 * 创建模拟文件系统结构
 */
export function createMockFileSystem(): Record<string, string> {
  return {
    '/project/src/index.ts': 'export function main() {}',
    '/project/src/utils.ts': 'export function helper() {}',
    '/project/package.json': '{"name": "test"}',
    '/project/README.md': '# Test Project'
  };
}

/**
 * 创建模拟配置
 */
export function createMockConfig(): Record<string, any> {
  return {
    model: 'mimo-v2.5-pro',
    maxTokens: 4096,
    temperature: 0.7,
    workingDirectory: '/test/project'
  };
}
