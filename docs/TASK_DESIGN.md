# MiMo Coding 优化 - 子任务拆分与接口设计

---

## 一、任务总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    MiMo Coding Optimization                     │
├─────────────────────────────────────────────────────────────────┤
│  Task 1: CodeValidator         - 代码验证器                     │
│  Task 2: CompletenessChecker   - 完整性检查器                   │
│  Task 3: IterationManager      - 迭代管理器                     │
│  Task 4: ContextManager        - 上下文管理器                   │
│  Task 5: ToolCallRepair        - 工具调用修复器                 │
│  Task 6: Integration           - 集成与主循环                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、Task 1: CodeValidator（代码验证器）

### 2.1 职责
- 工具执行后验证结果
- 语法检查、类型检查、模式检查
- 生成修复建议

### 2.2 接口定义

```typescript
// src/core/validator/types.ts

/**
 * 验证请求
 */
export interface ValidationRequest {
  /** 工具名称 */
  toolName: string;
  /** 工具参数 */
  toolArgs: Record<string, any>;
  /** 工具执行结果 */
  toolResult: ToolResult;
  /** 文件路径（如果是文件操作） */
  filePath?: string;
  /** 编程语言 */
  language?: string;
}

/**
 * 验证结果
 */
export interface ValidationResult {
  /** 是否通过验证 */
  passed: boolean;
  /** 验证检查项 */
  checks: ValidationCheck[];
  /** 修复建议 */
  suggestions: string[];
  /** 严重程度: error 阻断, warning 警告, info 信息 */
  severity: 'error' | 'warning' | 'info';
}

/**
 * 单项检查结果
 */
export interface ValidationCheck {
  /** 检查名称 */
  name: string;
  /** 检查类型 */
  type: 'syntax' | 'type' | 'pattern' | 'logic';
  /** 是否通过 */
  passed: boolean;
  /** 检查消息 */
  message: string;
  /** 严重程度 */
  severity: 'error' | 'warning' | 'info';
  /** 错误位置（可选） */
  location?: SourceLocation;
}

/**
 * 源码位置
 */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * 工具结果
 */
export interface ToolResult {
  /** 结果内容 */
  content: string;
  /** 是否错误 */
  isError?: boolean;
  /** 元数据 */
  metadata?: Record<string, any>;
}
```

### 2.3 主接口

```typescript
// src/core/validator/ICodeValidator.ts

export interface ICodeValidator {
  /**
   * 验证工具结果
   * 
   * @param request 验证请求
   * @returns 验证结果
   */
  validate(request: ValidationRequest): Promise<ValidationResult>;

  /**
   * 注册自定义检查器
   * 
   * @param checker 检查器实现
   */
  registerChecker(checker: IChecker): void;

  /**
   * 启用/禁用检查类型
   * 
   * @param type 检查类型
   * @param enabled 是否启用
   */
  setCheckerEnabled(type: string, enabled: boolean): void;
}

/**
 * 检查器接口
 */
export interface IChecker {
  /** 检查器名称 */
  name: string;
  /** 检查器类型 */
  type: 'syntax' | 'type' | 'pattern' | 'logic';

  /**
   * 执行检查
   * 
   * @param request 验证请求
   * @returns 检查结果列表
   */
  check(request: ValidationRequest): Promise<ValidationCheck[]>;
}
```

### 2.4 输入/输出示例

```typescript
// 输入
const request: ValidationRequest = {
  toolName: 'write_file',
  toolArgs: {
    path: '/src/utils.ts',
    content: 'export function add(a, b) { return a + b; }'
  },
  toolResult: {
    content: 'File written successfully'
  },
  language: 'typescript'
};

// 输出
const result: ValidationResult = {
  passed: true,
  checks: [
    {
      name: 'syntax-check',
      type: 'syntax',
      passed: true,
      message: '语法正确',
      severity: 'info'
    },
    {
      name: 'type-check',
      type: 'type',
      passed: true,
      message: '类型检查通过',
      severity: 'info'
    }
  ],
  suggestions: [],
  severity: 'info'
};
```

---

## 三、Task 2: CompletenessChecker（完整性检查器）

### 3.1 职责
- 检查代码完整性
- 检查任务完成度
- 生成补全建议

### 3.2 接口定义

```typescript
// src/core/completeness/types.ts

/**
 * 完整性检查请求
 */
export interface CompletenessRequest {
  /** 原始任务描述 */
  task: string;
  /** 生成的代码 */
  generatedCode: string;
  /** 代码上下文 */
  context: CodeContext;
  /** 是否为测试任务 */
  isTestTask?: boolean;
}

/**
 * 代码上下文
 */
export interface CodeContext {
  /** 项目根目录 */
  projectRoot: string;
  /** 当前文件路径 */
  currentFile?: string;
  /** 已读取的文件列表 */
  readFiles: string[];
  /** 已修改的文件列表 */
  modifiedFiles: string[];
  /** 编程语言 */
  language: string;
  /** 相关的代码片段 */
  relatedCode?: string[];
}

/**
 * 完整性检查结果
 */
export interface CompletenessResult {
  /** 是否完整 */
  complete: boolean;
  /** 完整性评分 0-100 */
  score: number;
  /** 发现的问题 */
  issues: CompletenessIssue[];
  /** 补全建议 */
  suggestions: string[];
  /** 需要的额外操作 */
  requiredActions: RequiredAction[];
}

/**
 * 完整性问题
 */
export interface CompletenessIssue {
  /** 问题类型 */
  type: 'incomplete-function' | 'missing-import' | 'missing-error-handling' 
      | 'placeholder-code' | 'empty-function' | 'missing-return' 
      | 'missing-feature' | 'incomplete-part';
  /** 严重程度 */
  severity: 'error' | 'warning' | 'info';
  /** 问题描述 */
  message: string;
  /** 问题位置 */
  location?: SourceLocation;
  /** 建议的修复 */
  suggestedFix?: string;
}

/**
 * 需要的额外操作
 */
export interface RequiredAction {
  /** 操作类型 */
  type: 'add-import' | 'implement-function' | 'add-error-handling' 
      | 'add-return' | 'complete-implementation';
  /** 操作描述 */
  description: string;
  /** 目标文件 */
  targetFile?: string;
  /** 目标位置 */
  targetLocation?: SourceLocation;
  /** 建议的代码 */
  suggestedCode?: string;
}
```

### 3.3 主接口

```typescript
// src/core/completeness/ICompletenessChecker.ts

export interface ICompletenessChecker {
  /**
   * 检查完整性
   * 
   * @param request 检查请求
   * @returns 检查结果
   */
  check(request: CompletenessRequest): Promise<CompletenessResult>;

  /**
   * 检查函数完整性
   * 
   * @param code 代码内容
   * @returns 问题列表
   */
  checkFunctionCompleteness(code: string): Promise<CompletenessIssue[]>;

  /**
   * 检查import完整性
   * 
   * @param code 代码内容
   * @param context 代码上下文
   * @returns 问题列表
   */
  checkImportCompleteness(code: string, context: CodeContext): Promise<CompletenessIssue[]>;

  /**
   * 检查任务完成度
   * 
   * @param task 任务描述
   * @param code 代码内容
   * @returns 完成度评分和问题
   */
  checkTaskCompletion(task: string, code: Promise<{
    score: number;
    issues: CompletenessIssue[];
  }>;
}
```

### 3.4 输入/输出示例

```typescript
// 输入
const request: CompletenessRequest = {
  task: "实现一个斐波那契数列函数，支持缓存",
  generatedCode: `
function fibonacci(n) {
  // TODO: 添加缓存
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
`,
  context: {
    projectRoot: '/project',
    readFiles: ['/project/src/index.ts'],
    modifiedFiles: ['/project/src/math.ts'],
    language: 'typescript'
  }
};

// 输出
const result: CompletenessResult = {
  complete: false,
  score: 60,
  issues: [
    {
      type: 'placeholder-code',
      severity: 'error',
      message: '函数包含TODO标记，缓存功能未实现',
      location: { file: '/project/src/math.ts', line: 2, column: 3 },
      suggestedFix: '添加Map缓存实现'
    }
  ],
  suggestions: [
    '请实现缓存功能',
    '建议使用Map存储已计算的值'
  ],
  requiredActions: [
    {
      type: 'complete-implementation',
      description: '实现缓存功能',
      targetFile: '/project/src/math.ts',
      suggestedCode: 'const cache = new Map();'
    }
  ]
};
```

---

## 四、Task 3: IterationManager（迭代管理器）

### 4.1 职责
- 管理任务重试
- 错误学习
- 增量式修复

### 4.2 接口定义

```typescript
// src/core/iteration/types.ts

/**
 * 迭代任务
 */
export interface IterationTask {
  /** 任务ID */
  id: string;
  /** 任务描述 */
  description: string;
  /** 初始上下文 */
  initialContext: TaskContext;
  /** 最大重试次数 */
  maxRetries?: number;
  /** 超时时间(ms) */
  timeout?: number;
}

/**
 * 任务上下文
 */
export interface TaskContext {
  /** 消息历史 */
  messages: ChatMessage[];
  /** 系统提示 */
  systemPrompt?: string;
  /** 工具定义 */
  tools?: ToolDefinition[];
  /** 任务状态 */
  state?: TaskState;
}

/**
 * 任务状态
 */
export interface TaskState {
  /** 任务目标 */
  objective: string;
  /** 当前步骤 */
  currentStep: number;
  /** 总步骤数 */
  totalSteps?: number;
  /** 已完成的子任务 */
  completedSubtasks: string[];
  /** 待完成的子任务 */
  pendingSubtasks: string[];
}

/**
 * 迭代结果
 */
export interface IterationResult {
  /** 任务ID */
  taskId: string;
  /** 是否成功 */
  success: boolean;
  /** 最终结果 */
  result?: TaskResult;
  /** 尝试次数 */
  attempts: number;
  /** 错误历史 */
  errorHistory: ErrorRecord[];
  /** 修复历史 */
  fixHistory: FixRecord[];
  /** 总耗时(ms) */
  duration: number;
}

/**
 * 错误记录
 */
export interface ErrorRecord {
  /** 尝试次数 */
  attempt: number;
  /** 错误消息 */
  message: string;
  /** 错误类型 */
  type: 'validation' | 'execution' | 'timeout' | 'unknown';
  /** 错误堆栈 */
  stack?: string;
  /** 时间戳 */
  timestamp: number;
  /** 相关的工具调用 */
  toolCall?: ToolCall;
}

/**
 * 修复记录
 */
export interface FixRecord {
  /** 修复的问题 */
  problem: string;
  /** 修复方法 */
  solution: string;
  /** 修复前的代码 */
  before: string;
  /** 修复后的代码 */
  after: string;
  /** 时间戳 */
  timestamp: number;
  /** 是否成功 */
  successful: boolean;
}

/**
 * 任务结果
 */
export interface TaskResult {
  /** 结果内容 */
  content: string;
  /** 是否成功 */
  success: boolean;
  /** 生成的代码 */
  code?: string;
  /** 执行的操作 */
  actions?: Action[];
  /** 元数据 */
  metadata?: Record<string, any>;
}

/**
 * 操作记录
 */
export interface Action {
  /** 操作类型 */
  type: 'file-read' | 'file-write' | 'shell-exec' | 'tool-call';
  /** 操作详情 */
  details: Record<string, any>;
  /** 操作结果 */
  result: any;
  /** 时间戳 */
  timestamp: number;
}
```

### 4.3 主接口

```typescript
// src/core/iteration/IIterationManager.ts

export interface IIterationManager {
  /**
   * 执行带重试的任务
   * 
   * @param task 迭代任务
   * @param executor 任务执行器
   * @param validator 结果验证器
   * @returns 迭代结果
   */
  execute(
    task: IterationTask,
    executor: ITaskExecutor,
    validator: IResultValidator
  ): Promise<IterationResult>;

  /**
   * 获取错误历史
   * 
   * @param taskId 任务ID
   * @returns 错误记录列表
   */
  getErrorHistory(taskId: string): ErrorRecord[];

  /**
   * 获取修复历史
   * 
   * @param taskId 任务ID
   * @returns 修复记录列表
   */
  getFixHistory(taskId: string): FixRecord[];

  /**
   * 查找相似修复经验
   * 
   * @param problem 问题描述
   * @returns 相关的修复记录
   */
  findSimilarFixes(problem: string): FixRecord[];

  /**
   * 清除历史记录
   * 
   * @param taskId 任务ID（可选，不传则清除所有）
   */
  clearHistory(taskId?: string): void;
}

/**
 * 任务执行器接口
 */
export interface ITaskExecutor {
  /**
   * 执行任务
   * 
   * @param context 任务上下文
   * @param attempt 当前尝试次数
   * @returns 任务结果
   */
  execute(context: TaskContext, attempt: number): Promise<TaskResult>;
}

/**
 * 结果验证器接口
 */
export interface IResultValidator {
  /**
   * 验证结果
   * 
   * @param task 原始任务
   * @param result 任务结果
   * @returns 验证结果
   */
  validate(task: IterationTask, result: TaskResult): Promise<ValidationResult>;
}
```

### 4.4 输入/输出示例

```typescript
// 输入
const task: IterationTask = {
  id: 'task-001',
  description: '实现快速排序算法',
  initialContext: {
    messages: [
      { role: 'user', content: '请实现快速排序算法' }
    ]
  },
  maxRetries: 3
};

// 输出
const result: IterationResult = {
  taskId: 'task-001',
  success: true,
  result: {
    content: '已实现快速排序算法',
    success: true,
    code: 'function quickSort(arr) { ... }'
  },
  attempts: 2,
  errorHistory: [
    {
      attempt: 1,
      message: '缺少边界条件处理',
      type: 'validation',
      timestamp: 1685000000000
    }
  ],
  fixHistory: [
    {
      problem: '缺少边界条件处理',
      solution: '添加空数组检查',
      before: 'function quickSort(arr) {',
      after: 'function quickSort(arr) {\n  if (arr.length <= 1) return arr;',
      timestamp: 1685000001000,
      successful: true
    }
  ],
  duration: 5000
};
```

---

## 五、Task 4: ContextManager（上下文管理器）

### 5.1 职责
- 上下文压缩
- 关键信息保持
- 智能摘要

### 5.2 接口定义

```typescript
// src/core/context/types.ts

/**
 * 上下文优化请求
 */
export interface ContextOptimizeRequest {
  /** 消息列表 */
  messages: ChatMessage[];
  /** 任务状态 */
  taskState: TaskState;
  /** 最大token数 */
  maxTokens: number;
  /** 当前token数 */
  currentTokens?: number;
  /** 优化策略 */
  strategy?: 'conservative' | 'balanced' | 'aggressive';
}

/**
 * 上下文优化结果
 */
export interface ContextOptimizeResult {
  /** 优化后的消息列表 */
  messages: ChatMessage[];
  /** 是否进行了折叠 */
  folded: boolean;
  /** 折叠前的消息数 */
  originalCount: number;
  /** 折叠后的消息数 */
  foldedCount: number;
  /** 保留的关键信息 */
  retainedInfo: KeyInfo | null;
  /** 摘要消息 */
  summaryMessage?: ChatMessage;
  /** token统计 */
  tokens: {
    before: number;
    after: number;
    saved: number;
  };
}

/**
 * 关键信息
 */
export interface KeyInfo {
  /** 任务目标 */
  taskObjective: string;
  /** 关键决策 */
  decisions: Decision[];
  /** 文件变更 */
  fileChanges: FileChange[];
  /** 错误记录 */
  errors: ErrorInfo[];
  /** 约束条件 */
  constraints: string[];
  /** 部分结果 */
  partialResults: string[];
}

/**
 * 决策记录
 */
export interface Decision {
  /** 决策内容 */
  content: string;
  /** 决策原因 */
  reason?: string;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 文件变更
 */
export interface FileChange {
  /** 文件路径 */
  file: string;
  /** 变更类型 */
  type: 'create' | 'modify' | 'delete';
  /** 变更描述 */
  description: string;
  /** 变更摘要 */
  diff?: string;
}

/**
 * 错误信息
 */
export interface ErrorInfo {
  /** 错误消息 */
  message: string;
  /** 错误类型 */
  type: string;
  /** 是否已解决 */
  resolved: boolean;
  /** 解决方案 */
  solution?: string;
  /** 时间戳 */
  timestamp: number;
}
```

### 5.3 主接口

```typescript
// src/core/context/IContextManager.ts

export interface IContextManager {
  /**
   * 优化上下文
   * 
   * @param request 优化请求
   * @returns 优化结果
   */
  optimize(request: ContextOptimizeRequest): Promise<ContextOptimizeResult>;

  /**
   * 提取关键信息
   * 
   * @param messages 消息列表
   * @param taskState 任务状态
   * @returns 关键信息
   */
  extractKeyInfo(messages: ChatMessage[], taskState: TaskState): Promise<KeyInfo>;

  /**
   * 生成摘要
   * 
   * @param messages 要摘要的消息
   * @param keyInfo 关键信息
   * @returns 摘要内容
   */
  generateSummary(messages: ChatMessage[], keyInfo: KeyInfo): Promise<string>;

  /**
   * 计算token数
   * 
   * @param messages 消息列表
   * @returns token数
   */
  countTokens(messages: ChatMessage[]): number;

  /**
   * 判断是否需要折叠
   * 
   * @param currentTokens 当前token数
   * @param maxTokens 最大token数
   * @returns 是否需要折叠
   */
  shouldFold(currentTokens: number, maxTokens: number): boolean;
}
```

### 5.4 输入/输出示例

```typescript
// 输入
const request: ContextOptimizeRequest = {
  messages: [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: '实现快速排序' },
    { role: 'assistant', content: '好的，我来实现...' },
    // ... 更多消息
  ],
  taskState: {
    objective: '实现快速排序算法',
    currentStep: 5,
    completedSubtasks: ['选择pivot', '分区操作'],
    pendingSubtasks: ['递归排序', '测试验证']
  },
  maxTokens: 8000,
  strategy: 'balanced'
};

// 输出
const result: ContextOptimizeResult = {
  messages: [
    { role: 'system', content: 'You are a coding assistant.' },
    { 
      role: 'assistant', 
      content: `[上下文折叠 - 任务进行中]

## 任务目标
实现快速排序算法

## 已完成
- 选择pivot
- 分区操作

## 待完成
- 递归排序
- 测试验证

## 对话摘要
用户要求实现快速排序，已完成pivot选择和分区操作...`
    },
    // ... 最近的消息
  ],
  folded: true,
  originalCount: 20,
  foldedCount: 8,
  retainedInfo: {
    taskObjective: '实现快速排序算法',
    decisions: [],
    fileChanges: [],
    errors: [],
    constraints: [],
    partialResults: []
  },
  tokens: {
    before: 12000,
    after: 6000,
    saved: 6000
  }
};
```

---

## 六、Task 5: ToolCallRepair（工具调用修复器）

### 6.1 职责
- JSON修复
- 参数类型修复
- 参数值修复
- 路径修复

### 6.2 接口定义

```typescript
// src/core/repair/types.ts

/**
 * 修复请求
 */
export interface RepairRequest {
  /** 工具调用 */
  toolCall: ToolCall;
  /** 工具定义 */
  toolDefinition?: ToolDefinition;
  /** 上下文 */
  context: RepairContext;
}

/**
 * 修复上下文
 */
export interface RepairContext {
  /** 工具schema映射 */
  toolSchemas: Record<string, ToolSchema>;
  /** 项目根目录 */
  projectRoot: string;
  /** 当前工作目录 */
  workingDirectory: string;
  /** 已读取的文件 */
  readFiles: Set<string>;
  /** 会话历史 */
  sessionHistory?: ChatMessage[];
}

/**
 * 工具Schema
 */
export interface ToolSchema {
  /** 工具名称 */
  name: string;
  /** 参数定义 */
  properties: Record<string, PropertySchema>;
  /** 必需参数 */
  required?: string[];
}

/**
 * 属性Schema
 */
export interface PropertySchema {
  /** 类型 */
  type: string;
  /** 描述 */
  description?: string;
  /** 默认值 */
  default?: any;
  /** 枚举值 */
  enum?: any[];
  /** 格式 */
  format?: string;
}

/**
 * 修复结果
 */
export interface RepairResult {
  /** 修复后的工具调用 */
  toolCall: ToolCall;
  /** 是否进行了修复 */
  repaired: boolean;
  /** 修复记录列表 */
  repairs: RepairRecord[];
  /** 修复摘要 */
  summary: string;
}

/**
 * 修复记录
 */
export interface RepairRecord {
  /** 修复类型 */
  type: 'json' | 'type' | 'value' | 'path' | 'schema';
  /** 修复描述 */
  description: string;
  /** 修复前 */
  before: string;
  /** 修复后 */
  after: string;
  /** 是否成功 */
  successful: boolean;
}

/**
 * 工具调用
 */
export interface ToolCall {
  /** 调用ID */
  id?: string;
  /** 调用类型 */
  type: 'function';
  /** 函数信息 */
  function: {
    /** 函数名 */
    name: string;
    /** 参数(JSON字符串) */
    arguments: string;
  };
}
```

### 6.3 主接口

```typescript
// src/core/repair/IToolCallRepair.ts

export interface IToolCallRepair {
  /**
   * 修复工具调用
   * 
   * @param request 修复请求
   * @returns 修复结果
   */
  repair(request: RepairRequest): Promise<RepairResult>;

  /**
   * 修复JSON
   * 
   * @param json JSON字符串
   * @returns 修复结果
   */
  repairJson(json: string): JsonRepairResult;

  /**
   * 修复参数类型
   * 
   * @param args 参数对象
   * @param schema 参数schema
   * @returns 修复后的参数
   */
  repairArgTypes(args: Record<string, any>, schema: ToolSchema): Record<string, any>;

  /**
   * 修复参数值
   * 
   * @param args 参数对象
   * @param schema 参数schema
   * @param context 修复上下文
   * @returns 修复后的参数
   */
  repairArgValues(
    args: Record<string, any>, 
    schema: ToolSchema, 
    context: RepairContext
  ): Promise<Record<string, any>>;

  /**
   * 修复路径
   * 
   * @param path 路径字符串
   * @param context 修复上下文
   * @returns 修复后的路径
   */
  repairPath(path: string, context: RepairContext): string;
}

/**
 * JSON修复结果
 */
export interface JsonRepairResult {
  /** 修复后的JSON字符串 */
  repaired: string;
  /** 是否进行了修复 */
  changed: boolean;
  /** 修复描述 */
  description: string;
  /** 是否为降级修复（返回空对象） */
  fallback: boolean;
}
```

### 6.4 输入/输出示例

```typescript
// 输入
const request: RepairRequest = {
  toolCall: {
    type: 'function',
    function: {
      name: 'write_file',
      arguments: '{"path":"/src/index.ts","content":"console.log(\\"hello\\"'
    }
  },
  context: {
    toolSchemas: {
      'write_file': {
        name: 'write_file',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    },
    projectRoot: '/project',
    workingDirectory: '/project',
    readFiles: new Set(['/project/src/index.ts'])
  }
};

// 输出
const result: RepairResult = {
  toolCall: {
    type: 'function',
    function: {
      name: 'write_file',
      arguments: '{"path":"/project/src/index.ts","content":"console.log(\\"hello\\")"}'
    }
  },
  repaired: true,
  repairs: [
    {
      type: 'json',
      description: '闭合未终止的字符串',
      before: '{"path":"/src/index.ts","content":"console.log(\\"hello\\"',
      after: '{"path":"/src/index.ts","content":"console.log(\\"hello\\")"}',
      successful: true
    },
    {
      type: 'path',
      description: '将相对路径转为绝对路径',
      before: '/src/index.ts',
      after: '/project/src/index.ts',
      successful: true
    }
  ],
  summary: '修复了JSON格式和路径问题'
};
```

---

## 七、Task 6: Integration（集成与主循环）

### 7.1 职责
- 集成所有组件
- 主循环控制
- 事件分发

### 7.2 接口定义

```typescript
// src/core/loop/types.ts

/**
 * MiMo循环配置
 */
export interface MiMoLoopConfig {
  /** 模型客户端 */
  client: IMiMoClient;
  /** 工具注册表 */
  tools: IToolRegistry;
  /** 代码验证器 */
  validator?: ICodeValidator;
  /** 完整性检查器 */
  completenessChecker?: ICompletenessChecker;
  /** 迭代管理器 */
  iterationManager?: IIterationManager;
  /** 上下文管理器 */
  contextManager?: IContextManager;
  /** 工具调用修复器 */
  toolRepair?: IToolCallRepair;
  /** 最大token数 */
  maxTokens?: number;
  /** 最大步骤数 */
  maxSteps?: number;
  /** 预算(USD) */
  budgetUsd?: number;
  /** 工作目录 */
  workingDirectory: string;
}

/**
 * 循环事件
 */
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

/**
 * 内容事件
 */
export interface ContentEvent {
  type: 'content';
  content: string;
}

/**
 * 工具调用事件
 */
export interface ToolCallEvent {
  type: 'tool_call';
  toolCall: ToolCall;
  repaired: boolean;
  repairs?: RepairRecord[];
}

/**
 * 工具结果事件
 */
export interface ToolResultEvent {
  type: 'tool_result';
  toolCall: ToolCall;
  result: ToolResult;
  validation?: ValidationResult;
}

/**
 * 验证事件
 */
export interface ValidationEvent {
  type: 'validation';
  result: ValidationResult;
}

/**
 * 完整性事件
 */
export interface CompletenessEvent {
  type: 'completeness';
  result: CompletenessResult;
}

/**
 * 迭代事件
 */
export interface IterationEvent {
  type: 'iteration';
  attempt: number;
  maxAttempts: number;
  error?: string;
}

/**
 * 上下文事件
 */
export interface ContextEvent {
  type: 'context_optimized';
  result: ContextOptimizeResult;
}

/**
 * 错误事件
 */
export interface ErrorEvent {
  type: 'error';
  error: string;
  recoverable: boolean;
}

/**
 * 使用量事件
 */
export interface UsageEvent {
  type: 'usage';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
}

/**
 * 完成事件
 */
export interface DoneEvent {
  type: 'done';
  success: boolean;
  result?: string;
}
```

### 7.3 主接口

```typescript
// src/core/loop/IMiMoLoop.ts

export interface IMiMoLoop {
  /**
   * 执行任务
   * 
   * @param task 任务描述
   * @returns 事件流
   */
  run(task: string): AsyncGenerator<LoopEvent>;

  /**
   * 执行单步
   * 
   * @param context 任务上下文
   * @returns 是否继续
   */
  step(context: TaskContext): Promise<boolean>;

  /**
   * 中断执行
   */
  abort(): void;

  /**
   * 获取当前状态
   */
  getState(): LoopState;

  /**
   * 配置更新
   * 
   * @param config 部分配置
   */
  configure(config: Partial<MiMoLoopConfig>): void;
}

/**
 * 循环状态
 */
export interface LoopState {
  /** 是否正在运行 */
  running: boolean;
  /** 当前步骤 */
  currentStep: number;
  /** 总token数 */
  totalTokens: number;
  /** 总成本 */
  totalCostUsd: number;
  /** 工具调用次数 */
  toolCalls: number;
  /** 错误次数 */
  errors: number;
}
```

### 7.4 输入/输出示例

```typescript
// 输入
const loop = new MiMoLoop({
  client: mimoClient,
  tools: toolRegistry,
  validator: codeValidator,
  completenessChecker: completenessChecker,
  iterationManager: iterationManager,
  contextManager: contextManager,
  toolRepair: toolRepair,
  maxTokens: 8000,
  maxSteps: 50,
  workingDirectory: '/project'
});

// 使用
for await (const event of loop.run('实现快速排序算法')) {
  switch (event.type) {
    case 'content':
      process.stdout.write(event.content);
      break;
    case 'tool_call':
      console.log(`Calling tool: ${event.toolCall.function.name}`);
      break;
    case 'validation':
      if (!event.result.passed) {
        console.log('Validation failed:', event.result.suggestions);
      }
      break;
    case 'done':
      console.log('Task completed:', event.success);
      break;
  }
}
```

---

## 八、依赖关系图

```
                    ┌─────────────────┐
                    │   IMiMoLoop     │
                    │  (Task 6)       │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ ICodeValidator│   │IIterationMgr  │   │IContextManager│
│  (Task 1)     │   │  (Task 3)     │   │  (Task 4)     │
└───────────────┘   └───────────────┘   └───────────────┘
        │                    │                    │
        ▼                    ▼                    ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│   IChecker    │   │ITaskExecutor  │   │   KeyInfo     │
│  (内部接口)    │   │IResultValidator│  │   (数据)      │
└───────────────┘   └───────────────┘   └───────────────┘
        │
        ▼
┌───────────────┐   ┌───────────────┐
│ICompleteness  │   │IToolCallRepair│
│  Checker      │   │  (Task 5)     │
│  (Task 2)     │   └───────────────┘
└───────────────┘
```

---

## 九、文件结构

```
src/core/
├── validator/
│   ├── types.ts                    # Task 1 类型定义
│   ├── ICodeValidator.ts           # Task 1 接口
│   ├── CodeValidator.ts            # Task 1 实现
│   ├── checkers/
│   │   ├── SyntaxChecker.ts
│   │   ├── TypeChecker.ts
│   │   ├── PatternChecker.ts
│   │   └── index.ts
│   └── index.ts
├── completeness/
│   ├── types.ts                    # Task 2 类型定义
│   ├── ICompletenessChecker.ts     # Task 2 接口
│   ├── CompletenessChecker.ts      # Task 2 实现
│   └── index.ts
├── iteration/
│   ├── types.ts                    # Task 3 类型定义
│   ├── IIterationManager.ts        # Task 3 接口
│   ├── IterationManager.ts         # Task 3 实现
│   └── index.ts
├── context/
│   ├── types.ts                    # Task 4 类型定义
│   ├── IContextManager.ts          # Task 4 接口
│   ├── ContextManager.ts           # Task 4 实现
│   └── index.ts
├── repair/
│   ├── types.ts                    # Task 5 类型定义
│   ├── IToolCallRepair.ts          # Task 5 接口
│   ├── ToolCallRepair.ts           # Task 5 实现
│   └── index.ts
├── loop/
│   ├── types.ts                    # Task 6 类型定义
│   ├── IMiMoLoop.ts                # Task 6 接口
│   ├── MiMoLoop.ts                 # Task 6 实现
│   └── index.ts
└── index.ts                        # 统一导出
```

---

## 十、开发顺序建议

### Phase 1: 基础组件（第1-2周）
1. Task 1: CodeValidator
2. Task 5: ToolCallRepair

### Phase 2: 核心组件（第3-4周）
3. Task 2: CompletenessChecker
4. Task 4: ContextManager

### Phase 3: 高级组件（第5-6周）
5. Task 3: IterationManager
6. Task 6: Integration

### Phase 4: 测试与优化（第7-8周）
7. 集成测试
8. 性能优化
9. 文档完善