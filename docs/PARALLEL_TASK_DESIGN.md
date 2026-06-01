# MiMo Coding 优化 - 并行开发子任务拆分

---

## 一、并行开发原则

### 1.1 依赖解耦策略

```
┌─────────────────────────────────────────────────────────────────┐
│                     并行开发原则                                 │
├─────────────────────────────────────────────────────────────────┤
│  1. 接口先行 - 先定义接口，再实现                                 │
│  2. Mock替代 - 依赖模块用Mock替代                                │
│  3. 独立测试 - 每个模块可独立测试                                 │
│  4. 契约驱动 - 通过接口契约保证兼容性                            │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 并行分组

```
┌─────────────────────────────────────────────────────────────────┐
│                      开发阶段                                    │
├─────────────────────────────────────────────────────────────────┤
│  Week 1-2: 基础层 (可并行)                                       │
│    ├── Group A: 类型定义 + 接口契约                               │
│    ├── Group B: 独立工具函数                                      │
│    └── Group C: Mock框架                                         │
├─────────────────────────────────────────────────────────────────┤
│  Week 3-4: 核心层 (可并行)                                       │
│    ├── Group D: CodeValidator 实现                               │
│    ├── Group E: ToolCallRepair 实现                              │
│    ├── Group F: CompletenessChecker 实现                         │
│    └── Group G: ContextManager 实现                              │
├─────────────────────────────────────────────────────────────────┤
│  Week 5-6: 集成层 (可并行)                                       │
│    ├── Group H: IterationManager 实现                            │
│    ├── Group I: MiMoLoop 集成                                    │
│    └── Group J: 测试套件                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、Week 1-2: 基础层（完全并行）

### 2.1 Group A: 类型定义 + 接口契约

**任务列表：**

| 任务ID | 任务描述 | 产出文件 | 可并行 |
|--------|----------|----------|--------|
| A1 | 定义公共类型 | `src/types/common.ts` | 是 |
| A2 | 定义验证器接口 | `src/types/validator.ts` | 是 |
| A3 | 定义完整性检查接口 | `src/types/completeness.ts` | 是 |
| A4 | 定义迭代管理接口 | `src/types/iteration.ts` | 是 |
| A5 | 定义上下文管理接口 | `src/types/context.ts` | 是 |
| A6 | 定义修复器接口 | `src/types/repair.ts` | 是 |
| A7 | 定义主循环接口 | `src/types/loop.ts` | 是 |
| A8 | 导出所有类型 | `src/types/index.ts` | 是 |

**接口定义：**

```typescript
// src/types/common.ts - A1

/** 工具调用 */
export interface ToolCall {
  id?: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** 工具结果 */
export interface ToolResult {
  content: string;
  isError?: boolean;
  metadata?: Record<string, any>;
}

/** 消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** 源码位置 */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  fn: (args: any, ctx?: any) => any;
}
```

```typescript
// src/types/validator.ts - A2

import { ToolCall, ToolResult, SourceLocation } from './common';

/** 验证请求 */
export interface ValidationRequest {
  toolName: string;
  toolArgs: Record<string, any>;
  toolResult: ToolResult;
  filePath?: string;
  language?: string;
}

/** 验证检查项 */
export interface ValidationCheck {
  name: string;
  type: 'syntax' | 'type' | 'pattern' | 'logic';
  passed: boolean;
  message: string;
  severity: 'error' | 'warning' | 'info';
  location?: SourceLocation;
}

/** 验证结果 */
export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
  suggestions: string[];
  severity: 'error' | 'warning' | 'info';
}

/** 检查器接口 */
export interface IChecker {
  name: string;
  type: 'syntax' | 'type' | 'pattern' | 'logic';
  check(request: ValidationRequest): Promise<ValidationCheck[]>;
}

/** 验证器接口 */
export interface ICodeValidator {
  validate(request: ValidationRequest): Promise<ValidationResult>;
  registerChecker(checker: IChecker): void;
  setCheckerEnabled(type: string, enabled: boolean): void;
}
```

```typescript
// src/types/completeness.ts - A3

import { SourceLocation, ChatMessage } from './common';

/** 代码上下文 */
export interface CodeContext {
  projectRoot: string;
  currentFile?: string;
  readFiles: string[];
  modifiedFiles: string[];
  language: string;
  relatedCode?: string[];
}

/** 完整性检查请求 */
export interface CompletenessRequest {
  task: string;
  generatedCode: string;
  context: CodeContext;
  isTestTask?: boolean;
}

/** 完整性问题 */
export interface CompletenessIssue {
  type: 'incomplete-function' | 'missing-import' | 'missing-error-handling' 
      | 'placeholder-code' | 'empty-function' | 'missing-return' 
      | 'missing-feature' | 'incomplete-part';
  severity: 'error' | 'warning' | 'info';
  message: string;
  location?: SourceLocation;
  suggestedFix?: string;
}

/** 需要的操作 */
export interface RequiredAction {
  type: 'add-import' | 'implement-function' | 'add-error-handling' 
      | 'add-return' | 'complete-implementation';
  description: string;
  targetFile?: string;
  targetLocation?: SourceLocation;
  suggestedCode?: string;
}

/** 完整性结果 */
export interface CompletenessResult {
  complete: boolean;
  score: number;
  issues: CompletenessIssue[];
  suggestions: string[];
  requiredActions: RequiredAction[];
}

/** 完整性检查器接口 */
export interface ICompletenessChecker {
  check(request: CompletenessRequest): Promise<CompletenessResult>;
  checkFunctionCompleteness(code: string): Promise<CompletenessIssue[]>;
  checkImportCompleteness(code: string, context: CodeContext): Promise<CompletenessIssue[]>;
  checkTaskCompletion(task: string, code: string): Promise<{ score: number; issues: CompletenessIssue[] }>;
}
```

```typescript
// src/types/iteration.ts - A4

import { ChatMessage, ToolCall, ToolDefinition } from './common';

/** 任务状态 */
export interface TaskState {
  objective: string;
  currentStep: number;
  totalSteps?: number;
  completedSubtasks: string[];
  pendingSubtasks: string[];
}

/** 任务上下文 */
export interface TaskContext {
  messages: ChatMessage[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  state?: TaskState;
}

/** 迭代任务 */
export interface IterationTask {
  id: string;
  description: string;
  initialContext: TaskContext;
  maxRetries?: number;
  timeout?: number;
}

/** 任务结果 */
export interface TaskResult {
  content: string;
  success: boolean;
  code?: string;
  actions?: Action[];
  metadata?: Record<string, any>;
}

/** 操作记录 */
export interface Action {
  type: 'file-read' | 'file-write' | 'shell-exec' | 'tool-call';
  details: Record<string, any>;
  result: any;
  timestamp: number;
}

/** 错误记录 */
export interface ErrorRecord {
  attempt: number;
  message: string;
  type: 'validation' | 'execution' | 'timeout' | 'unknown';
  stack?: string;
  timestamp: number;
  toolCall?: ToolCall;
}

/** 修复记录 */
export interface FixRecord {
  problem: string;
  solution: string;
  before: string;
  after: string;
  timestamp: number;
  successful: boolean;
}

/** 迭代结果 */
export interface IterationResult {
  taskId: string;
  success: boolean;
  result?: TaskResult;
  attempts: number;
  errorHistory: ErrorRecord[];
  fixHistory: FixRecord[];
  duration: number;
}

/** 任务执行器接口 */
export interface ITaskExecutor {
  execute(context: TaskContext, attempt: number): Promise<TaskResult>;
}

/** 结果验证器接口 */
export interface IResultValidator {
  validate(task: IterationTask, result: TaskResult): Promise<{ passed: boolean; errors: string[] }>;
}

/** 迭代管理器接口 */
export interface IIterationManager {
  execute(task: IterationTask, executor: ITaskExecutor, validator: IResultValidator): Promise<IterationResult>;
  getErrorHistory(taskId: string): ErrorRecord[];
  getFixHistory(taskId: string): FixRecord[];
  findSimilarFixes(problem: string): FixRecord[];
  clearHistory(taskId?: string): void;
}
```

```typescript
// src/types/context.ts - A5

import { ChatMessage } from './common';

/** 任务状态 (复用) */
export interface TaskState {
  objective: string;
  currentStep: number;
  totalSteps?: number;
  completedSubtasks: string[];
  pendingSubtasks: string[];
}

/** 决策记录 */
export interface Decision {
  content: string;
  reason?: string;
  timestamp: number;
}

/** 文件变更 */
export interface FileChange {
  file: string;
  type: 'create' | 'modify' | 'delete';
  description: string;
  diff?: string;
}

/** 错误信息 */
export interface ErrorInfo {
  message: string;
  type: string;
  resolved: boolean;
  solution?: string;
  timestamp: number;
}

/** 关键信息 */
export interface KeyInfo {
  taskObjective: string;
  decisions: Decision[];
  fileChanges: FileChange[];
  errors: ErrorInfo[];
  constraints: string[];
  partialResults: string[];
}

/** 上下文优化请求 */
export interface ContextOptimizeRequest {
  messages: ChatMessage[];
  taskState: TaskState;
  maxTokens: number;
  currentTokens?: number;
  strategy?: 'conservative' | 'balanced' | 'aggressive';
}

/** 上下文优化结果 */
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

/** 上下文管理器接口 */
export interface IContextManager {
  optimize(request: ContextOptimizeRequest): Promise<ContextOptimizeResult>;
  extractKeyInfo(messages: ChatMessage[], taskState: TaskState): Promise<KeyInfo>;
  generateSummary(messages: ChatMessage[], keyInfo: KeyInfo): Promise<string>;
  countTokens(messages: ChatMessage[]): number;
  shouldFold(currentTokens: number, maxTokens: number): boolean;
}
```

```typescript
// src/types/repair.ts - A6

import { ToolCall } from './common';

/** 工具Schema */
export interface ToolSchema {
  name: string;
  properties: Record<string, PropertySchema>;
  required?: string[];
}

/** 属性Schema */
export interface PropertySchema {
  type: string;
  description?: string;
  default?: any;
  enum?: any[];
  format?: string;
}

/** 修复上下文 */
export interface RepairContext {
  toolSchemas: Record<string, ToolSchema>;
  projectRoot: string;
  workingDirectory: string;
  readFiles: Set<string>;
  sessionHistory?: any[];
}

/** 修复请求 */
export interface RepairRequest {
  toolCall: ToolCall;
  toolDefinition?: any;
  context: RepairContext;
}

/** 修复记录 */
export interface RepairRecord {
  type: 'json' | 'type' | 'value' | 'path' | 'schema';
  description: string;
  before: string;
  after: string;
  successful: boolean;
}

/** 修复结果 */
export interface RepairResult {
  toolCall: ToolCall;
  repaired: boolean;
  repairs: RepairRecord[];
  summary: string;
}

/** JSON修复结果 */
export interface JsonRepairResult {
  repaired: string;
  changed: boolean;
  description: string;
  fallback: boolean;
}

/** 修复器接口 */
export interface IToolCallRepair {
  repair(request: RepairRequest): Promise<RepairResult>;
  repairJson(json: string): JsonRepairResult;
  repairArgTypes(args: Record<string, any>, schema: ToolSchema): Record<string, any>;
  repairArgValues(args: Record<string, any>, schema: ToolSchema, context: RepairContext): Promise<Record<string, any>>;
  repairPath(path: string, context: RepairContext): string;
}
```

```typescript
// src/types/loop.ts - A7

import { ToolCall, ToolResult, ChatMessage } from './common';
import { ValidationResult } from './validator';
import { CompletenessResult } from './completeness';
import { ContextOptimizeResult } from './context';
import { RepairRecord } from './repair';

/** 循环配置 */
export interface MiMoLoopConfig {
  client: any; // IMiMoClient
  tools: any;  // IToolRegistry
  validator?: any; // ICodeValidator
  completenessChecker?: any; // ICompletenessChecker
  iterationManager?: any; // IIterationManager
  contextManager?: any; // IContextManager
  toolRepair?: any; // IToolCallRepair
  maxTokens?: number;
  maxSteps?: number;
  budgetUsd?: number;
  workingDirectory: string;
}

/** 循环事件 */
export type LoopEvent = 
  | ContentEvent
  | ToolCallEvent
  | ToolResultEvent
  | ValidationEvent
  | CompletenessEvent
  | IterationEvent
  | ContextEvent
  | ErrorEvent
  | UsageEvent
  | DoneEvent;

export interface ContentEvent {
  type: 'content';
  content: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  toolCall: ToolCall;
  repaired: boolean;
  repairs?: RepairRecord[];
}

export interface ToolResultEvent {
  type: 'tool_result';
  toolCall: ToolCall;
  result: ToolResult;
  validation?: ValidationResult;
}

export interface ValidationEvent {
  type: 'validation';
  result: ValidationResult;
}

export interface CompletenessEvent {
  type: 'completeness';
  result: CompletenessResult;
}

export interface IterationEvent {
  type: 'iteration';
  attempt: number;
  maxAttempts: number;
  error?: string;
}

export interface ContextEvent {
  type: 'context_optimized';
  result: ContextOptimizeResult;
}

export interface ErrorEvent {
  type: 'error';
  error: string;
  recoverable: boolean;
}

export interface UsageEvent {
  type: 'usage';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface DoneEvent {
  type: 'done';
  success: boolean;
  result?: string;
}

/** 循环状态 */
export interface LoopState {
  running: boolean;
  currentStep: number;
  totalTokens: number;
  totalCostUsd: number;
  toolCalls: number;
  errors: number;
}

/** 主循环接口 */
export interface IMiMoLoop {
  run(task: string): AsyncGenerator<LoopEvent>;
  step(context: any): Promise<boolean>;
  abort(): void;
  getState(): LoopState;
  configure(config: Partial<MiMoLoopConfig>): void;
}
```

### 2.2 Group B: 独立工具函数（可并行）

**任务列表：**

| 任务ID | 任务描述 | 产出文件 | 可并行 |
|--------|----------|----------|--------|
| B1 | JSON修复工具 | `src/utils/json-repair.ts` | 是 |
| B2 | 路径处理工具 | `src/utils/path-utils.ts` | 是 |
| B3 | Token计算工具 | `src/utils/token-counter.ts` | 是 |
| B4 | 字符串相似度工具 | `src/utils/similarity.ts` | 是 |
| B5 | 语法检查工具 | `src/utils/syntax-checker.ts` | 是 |
| B6 | 正则表达式工具 | `src/utils/regex-utils.ts` | 是 |

**接口定义：**

```typescript
// src/utils/json-repair.ts - B1

export interface JsonRepairResult {
  repaired: string;
  changed: boolean;
  description: string;
  fallback: boolean;
}

/**
 * 修复截断的JSON
 */
export function repairTruncatedJson(input: string): JsonRepairResult;

/**
 * 平衡括号
 */
export function balanceBrackets(input: string): string;

/**
 * 闭合字符串
 */
export function closeString(input: string): string;

/**
 * 移除尾部逗号
 */
export function removeTrailingComma(input: string): string;
```

```typescript
// src/utils/path-utils.ts - B2

/**
 * 规范化路径
 */
export function normalizePath(path: string): string;

/**
 * 将相对路径转为绝对路径
 */
export function toAbsolutePath(path: string, basePath: string): string;

/**
 * 检查路径是否在目录内
 */
export function isPathInside(path: string, directory: string): boolean;

/**
 * 获取文件扩展名
 */
export function getExtension(path: string): string;

/**
 * 检测编程语言
 */
export function detectLanguage(filePath: string): string;
```

```typescript
// src/utils/token-counter.ts - B3

/**
 * 计算文本的token数（估算）
 */
export function estimateTokens(text: string): number;

/**
 * 计算消息列表的token数
 */
export function countMessagesTokens(messages: any[]): number;

/**
 * 截断文本到指定token数
 */
export function truncateToTokens(text: string, maxTokens: number): string;
```

```typescript
// src/utils/similarity.ts - B4

/**
 * 计算字符串相似度（Levenshtein距离）
 */
export function levenshteinSimilarity(a: string, b: string): number;

/**
 * 计算Jaccard相似度
 */
export function jaccardSimilarity(a: string, b: string): number;

/**
 * 查找最相似的字符串
 */
export function findMostSimilar(target: string, candidates: string[]): {
  item: string;
  similarity: number;
};
```

```typescript
// src/utils/syntax-checker.ts - B5

export interface SyntaxCheckResult {
  valid: boolean;
  errors: SyntaxError[];
}

export interface SyntaxError {
  message: string;
  line: number;
  column: number;
}

/**
 * 检查TypeScript/JavaScript语法
 */
export function checkTypeScriptSyntax(code: string): SyntaxCheckResult;

/**
 * 检查Python语法
 */
export function checkPythonSyntax(code: string): SyntaxCheckResult;

/**
 * 检查JSON语法
 */
export function checkJsonSyntax(code: string): SyntaxCheckResult;
```

### 2.3 Group C: Mock框架（可并行）

**任务列表：**

| 任务ID | 任务描述 | 产出文件 | 可并行 |
|--------|----------|----------|--------|
| C1 | Mock验证器 | `src/mocks/MockValidator.ts` | 是 |
| C2 | Mock完整性检查器 | `src/mocks/MockCompletenessChecker.ts` | 是 |
| C3 | Mock迭代管理器 | `src/mocks/MockIterationManager.ts` | 是 |
| C4 | Mock上下文管理器 | `src/mocks/MockContextManager.ts` | 是 |
| C5 | Mock修复器 | `src/mocks/MockRepair.ts` | 是 |
| C6 | Mock模型客户端 | `src/mocks/MockClient.ts` | 是 |
| C7 | Mock工具注册表 | `src/mocks/MockToolRegistry.ts` | 是 |

**示例：**

```typescript
// src/mocks/MockValidator.ts - C1

import { ICodeValidator, ValidationRequest, ValidationResult, IChecker } from '../types/validator';

export class MockValidator implements ICodeValidator {
  private mockResult: ValidationResult = {
    passed: true,
    checks: [],
    suggestions: [],
    severity: 'info'
  };

  setResult(result: ValidationResult): void {
    this.mockResult = result;
  }

  async validate(request: ValidationRequest): Promise<ValidationResult> {
    return this.mockResult;
  }

  registerChecker(checker: IChecker): void {
    // Mock: no-op
  }

  setCheckerEnabled(type: string, enabled: boolean): void {
    // Mock: no-op
  }
}
```

```typescript
// src/mocks/MockClient.ts - C6

export class MockClient {
  private responses: Map<string, string> = new Map();
  private callHistory: any[] = [];

  setResponse(prompt: string, response: string): void {
    this.responses.set(prompt, response);
  }

  async chat(options: any): Promise<any> {
    this.callHistory.push(options);
    
    const lastMessage = options.messages[options.messages.length - 1];
    const response = this.responses.get(lastMessage.content) || 'Mock response';
    
    return {
      content: response,
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150
      }
    };
  }

  getCallHistory(): any[] {
    return this.callHistory;
  }

  clearHistory(): void {
    this.callHistory = [];
  }
}
```

---

## 三、Week 3-4: 核心层（可并行）

### 3.1 Group D: CodeValidator 实现

**任务列表：**

| 任务ID | 任务描述 | 依赖 | 可并行 |
|--------|----------|------|--------|
| D1 | SyntaxChecker 实现 | A2, B5 | 是 |
| D2 | TypeChecker 实现 | A2 | 是 |
| D3 | PatternChecker 实现 | A2, B6 | 是 |
| D4 | CodeValidator 主类 | D1, D2, D3 | 否 |
| D5 | 单元测试 | D4 | 是 |

**接口：**

```typescript
// src/validators/SyntaxChecker.ts - D1

import { IChecker, ValidationCheck, ValidationRequest } from '../types/validator';

export class SyntaxChecker implements IChecker {
  name = 'syntax-checker';
  type = 'syntax' as const;

  async check(request: ValidationRequest): Promise<ValidationCheck[]>;
}
```

```typescript
// src/validators/TypeChecker.ts - D2

import { IChecker, ValidationCheck, ValidationRequest } from '../types/validator';

export class TypeChecker implements IChecker {
  name = 'type-checker';
  type = 'type' as const;

  async check(request: ValidationRequest): Promise<ValidationCheck[]>;
}
```

```typescript
// src/validators/PatternChecker.ts - D3

import { IChecker, ValidationCheck, ValidationRequest } from '../types/validator';

export class PatternChecker implements IChecker {
  name = 'pattern-checker';
  type = 'pattern' as const;

  async check(request: ValidationRequest): Promise<ValidationCheck[]>;
}
```

```typescript
// src/validators/CodeValidator.ts - D4

import { ICodeValidator, ValidationRequest, ValidationResult, IChecker } from '../types/validator';

export class CodeValidator implements ICodeValidator {
  constructor(options?: { enabledCheckers?: string[] });
  
  async validate(request: ValidationRequest): Promise<ValidationResult>;
  registerChecker(checker: IChecker): void;
  setCheckerEnabled(type: string, enabled: boolean): void;
}
```

### 3.2 Group E: ToolCallRepair 实现

**任务列表：**

| 任务ID | 任务描述 | 依赖 | 可并行 |
|--------|----------|------|--------|
| E1 | JsonRepair 实现 | B1 | 是 |
| E2 | TypeRepair 实现 | A6 | 是 |
| E3 | ValueRepair 实现 | A6 | 是 |
| E4 | PathRepair 实现 | B2 | 是 |
| E5 | ToolCallRepair 主类 | E1-E4 | 否 |
| E6 | 单元测试 | E5 | 是 |

**接口：**

```typescript
// src/repair/JsonRepair.ts - E1

import { JsonRepairResult } from '../types/repair';

export class JsonRepair {
  repair(input: string): JsonRepairResult;
}
```

```typescript
// src/repair/TypeRepair.ts - E2

import { ToolSchema } from '../types/repair';

export class TypeRepair {
  repair(args: Record<string, any>, schema: ToolSchema): Record<string, any>;
}
```

```typescript
// src/repair/ValueRepair.ts - E3

import { ToolSchema, RepairContext } from '../types/repair';

export class ValueRepair {
  async repair(args: Record<string, any>, schema: ToolSchema, context: RepairContext): Promise<Record<string, any>>;
}
```

```typescript
// src/repair/PathRepair.ts - E4

import { RepairContext } from '../types/repair';

export class PathRepair {
  repair(path: string, context: RepairContext): string;
}
```

```typescript
// src/repair/ToolCallRepair.ts - E5

import { IToolCallRepair, RepairRequest, RepairResult, JsonRepairResult, ToolSchema, RepairContext } from '../types/repair';

export class ToolCallRepair implements IToolCallRepair {
  constructor();
  
  async repair(request: RepairRequest): Promise<RepairResult>;
  repairJson(json: string): JsonRepairResult;
  repairArgTypes(args: Record<string, any>, schema: ToolSchema): Record<string, any>;
  repairArgValues(args: Record<string, any>, schema: ToolSchema, context: RepairContext): Promise<Record<string, any>>;
  repairPath(path: string, context: RepairContext): string;
}
```

### 3.3 Group F: CompletenessChecker 实现

**任务列表：**

| 任务ID | 任务描述 | 依赖 | 可并行 |
|--------|----------|------|--------|
| F1 | FunctionChecker 实现 | A3 | 是 |
| F2 | ImportChecker 实现 | A3 | 是 |
| F3 | ErrorHandlingChecker 实现 | A3 | 是 |
| F4 | TaskCompletionChecker 实现 | A3, C6 | 是 |
| F5 | CompletenessChecker 主类 | F1-F4 | 否 |
| F6 | 单元测试 | F5 | 是 |

### 3.4 Group G: ContextManager 实现

**任务列表：**

| 任务ID | 任务描述 | 依赖 | 可并行 |
|--------|----------|------|--------|
| G1 | KeyInfoExtractor 实现 | A5 | 是 |
| G2 | MessageFolder 实现 | A5, B3 | 是 |
| G3 | SummaryGenerator 实现 | A5, C6 | 是 |
| G4 | ContextManager 主类 | G1-G3 | 否 |
| G5 | 单元测试 | G4 | 是 |

---

## 四、Week 5-6: 集成层（可并行）

### 4.1 Group H: IterationManager 实现

**任务列表：**

| 任务ID | 任务描述 | 依赖 | 可并行 |
|--------|----------|------|--------|
| H1 | ErrorRecorder 实现 | A4 | 是 |
| H2 | FixRecorder 实现 | A4, B4 | 是 |
| H3 | RetryStrategy 实现 | A4 | 是 |
| H4 | IterationManager 主类 | H1-H3 | 否 |
| H5 | 单元测试 | H4 | 是 |

### 4.2 Group I: MiMoLoop 集成

**任务列表：**

| 任务ID | 任务描述 | 依赖 | 可并行 |
|--------|----------|------|--------|
| I1 | LoopState 管理 | A7 | 是 |
| I2 | EventDispatcher 实现 | A7 | 是 |
| I3 | MiMoLoop 主类 | D4, E5, F5, G4, H4 | 否 |
| I4 | 集成测试 | I3 | 是 |

### 4.3 Group J: 测试套件

**任务列表：**

| 任务ID | 任务描述 | 依赖 | 可并行 |
|--------|----------|------|--------|
| J1 | 测试工具函数 | 无 | 是 |
| J2 | 测试数据生成器 | J1 | 是 |
| J3 | 集成测试场景 | I3 | 是 |
| J4 | 性能测试 | I3 | 是 |
| J5 | E2E测试 | I3 | 是 |

---

## 五、完整任务矩阵

```
Week 1-2 (基础层 - 完全并行)
├── Group A: 类型定义
│   ├── A1: common.ts ─────────────────────────────────┐
│   ├── A2: validator.ts ──────────────────────────────┤
│   ├── A3: completeness.ts ───────────────────────────┤
│   ├── A4: iteration.ts ──────────────────────────────┤
│   ├── A5: context.ts ────────────────────────────────┤
│   ├── A6: repair.ts ─────────────────────────────────┤
│   ├── A7: loop.ts ───────────────────────────────────┤
│   └── A8: index.ts ──────────────────────────────────┤
├── Group B: 工具函数                                    │
│   ├── B1: json-repair.ts ────────────────────────────┤
│   ├── B2: path-utils.ts ─────────────────────────────┤
│   ├── B3: token-counter.ts ──────────────────────────┤
│   ├── B4: similarity.ts ─────────────────────────────┤
│   ├── B5: syntax-checker.ts ─────────────────────────┤
│   └── B6: regex-utils.ts ────────────────────────────┤
└── Group C: Mock框架                                    │
    ├── C1: MockValidator.ts ──────────────────────────┤
    ├── C2: MockCompletenessChecker.ts ────────────────┤
    ├── C3: MockIterationManager.ts ───────────────────┤
    ├── C4: MockContextManager.ts ─────────────────────┤
    ├── C5: MockRepair.ts ─────────────────────────────┤
    ├── C6: MockClient.ts ─────────────────────────────┤
    └── C7: MockToolRegistry.ts ───────────────────────┘
                                    │
                                    ▼
Week 3-4 (核心层 - 可并行)
├── Group D: CodeValidator
│   ├── D1: SyntaxChecker ◄── A2, B5
│   ├── D2: TypeChecker ◄── A2
│   ├── D3: PatternChecker ◄── A2, B6
│   ├── D4: CodeValidator ◄── D1, D2, D3
│   └── D5: 测试 ◄── D4
├── Group E: ToolCallRepair
│   ├── E1: JsonRepair ◄── B1
│   ├── E2: TypeRepair ◄── A6
│   ├── E3: ValueRepair ◄── A6
│   ├── E4: PathRepair ◄── B2
│   ├── E5: ToolCallRepair ◄── E1-E4
│   └── E6: 测试 ◄── E5
├── Group F: CompletenessChecker
│   ├── F1: FunctionChecker ◄── A3
│   ├── F2: ImportChecker ◄── A3
│   ├── F3: ErrorHandlingChecker ◄── A3
│   ├── F4: TaskCompletionChecker ◄── A3, C6
│   ├── F5: CompletenessChecker ◄── F1-F4
│   └── F6: 测试 ◄── F5
└── Group G: ContextManager
    ├── G1: KeyInfoExtractor ◄── A5
    ├── G2: MessageFolder ◄── A5, B3
    ├── G3: SummaryGenerator ◄── A5, C6
    ├── G4: ContextManager ◄── G1-G3
    └── G5: 测试 ◄── G4
                                    │
                                    ▼
Week 5-6 (集成层 - 可并行)
├── Group H: IterationManager
│   ├── H1: ErrorRecorder ◄── A4
│   ├── H2: FixRecorder ◄── A4, B4
│   ├── H3: RetryStrategy ◄── A4
│   ├── H4: IterationManager ◄── H1-H3
│   └── H5: 测试 ◄── H4
├── Group I: MiMoLoop
│   ├── I1: LoopState ◄── A7
│   ├── I2: EventDispatcher ◄── A7
│   ├── I3: MiMoLoop ◄── D4, E5, F5, G4, H4
│   └── I4: 集成测试 ◄── I3
└── Group J: 测试套件
    ├── J1: 测试工具
    ├── J2: 测试数据生成器
    ├── J3: 集成测试场景 ◄── I3
    ├── J4: 性能测试 ◄── I3
    └── J5: E2E测试 ◄── I3
```

---

## 六、并行开发检查清单

### 6.1 每个任务的完成标准

```markdown
## 任务完成检查清单

### 代码完成
- [ ] 接口实现完整
- [ ] 类型定义正确
- [ ] 错误处理完善
- [ ] 边界条件处理

### 测试完成
- [ ] 单元测试覆盖 > 80%
- [ ] 边界条件测试
- [ ] 错误场景测试
- [ ] Mock依赖测试

### 文档完成
- [ ] 接口文档
- [ ] 使用示例
- [ ] 注意事项

### 代码质量
- [ ] ESLint通过
- [ ] TypeScript编译通过
- [ ] 无any类型滥用
- [ ] 命名规范
```

### 6.2 集成检查清单

```markdown
## 集成检查清单

### 接口兼容性
- [ ] 输入类型匹配
- [ ] 输出类型匹配
- [ ] 错误处理一致
- [ ] 异步行为一致

### Mock验证
- [ ] Mock行为与真实实现一致
- [ ] Mock返回值格式正确
- [ ] Mock错误场景覆盖

### 集成测试
- [ ] 模块间调用正确
- [ ] 数据流转正确
- [ ] 错误传播正确
- [ ] 性能符合预期
```

---

## 七、快速启动指南

### 7.1 开发者A（负责Group D: CodeValidator）

```bash
# 1. 创建分支
git checkout -b feature/code-validator

# 2. 查看依赖接口
cat src/types/validator.ts

# 3. 使用Mock进行开发
cat src/mocks/MockValidator.ts

# 4. 实现各个Checker
touch src/validators/SyntaxChecker.ts
touch src/validators/TypeChecker.ts
touch src/validators/PatternChecker.ts

# 5. 实现主类
touch src/validators/CodeValidator.ts

# 6. 编写测试
touch src/validators/__tests__/CodeValidator.test.ts
```

### 7.2 开发者B（负责Group E: ToolCallRepair）

```bash
# 1. 创建分支
git checkout -b feature/tool-call-repair

# 2. 查看依赖接口
cat src/types/repair.ts

# 3. 使用Mock进行开发
cat src/mocks/MockRepair.ts

# 4. 实现各个修复器
touch src/repair/JsonRepair.ts
touch src/repair/TypeRepair.ts
touch src/repair/ValueRepair.ts
touch src/repair/PathRepair.ts

# 5. 实现主类
touch src/repair/ToolCallRepair.ts

# 6. 编写测试
touch src/repair/__tests__/ToolCallRepair.test.ts
```

### 7.3 开发者C（负责Group G: ContextManager）

```bash
# 1. 创建分支
git checkout -b feature/context-manager

# 2. 查看依赖接口
cat src/types/context.ts

# 3. 使用Mock进行开发
cat src/mocks/MockContextManager.ts

# 4. 实现各个组件
touch src/context/KeyInfoExtractor.ts
touch src/context/MessageFolder.ts
touch src/context/SummaryGenerator.ts

# 5. 实现主类
touch src/context/ContextManager.ts

# 6. 编写测试
touch src/context/__tests__/ContextManager.test.ts
```

---

## 八、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 接口变更 | 所有依赖模块需要修改 | 接口评审冻结机制 |
| Mock不准确 | 集成时发现问题 | Mock与真实实现同步更新 |
| 测试覆盖不足 | 集成后出现bug | 强制测试覆盖率检查 |
| 性能问题 | 最终体验差 | 早期性能测试 |

---

**文档版本**: 4.0.0  
**最后更新**: 2026-05-27  
**支持最大并行度**: 7个开发者同时开发