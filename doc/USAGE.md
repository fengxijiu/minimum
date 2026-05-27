# MiMo Coding Optimizer - 使用指南

## 一、安装

### 1.1 从源码安装

```bash
# 克隆仓库
git clone <repository-url>
cd minimum

# 安装依赖
npm install

# 构建项目
npm run build

# 链接到全局（可选）
npm link
```

### 1.2 作为依赖安装

```json
{
  "dependencies": {
    "mimo-coding-optimizer": "file:../minimum"
  }
}
```

---

## 二、快速开始

### 2.1 最简单的使用方式

```typescript
import { MiMoLoop, MockClient, MockToolRegistry } from 'mimo-coding-optimizer';

// 1. 创建模型客户端
const client = new MockClient();
client.setDefaultResponse('我来实现这个功能...');

// 2. 创建工具注册表
const tools = new MockToolRegistry();

// 注册文件写入工具
tools.register({
  name: 'write_file',
  description: '写入文件内容',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '文件内容' }
    },
    required: ['path', 'content']
  },
  fn: async (args) => {
    // 实际的文件写入逻辑
    console.log(`Writing to ${args.path}`);
    return `File written: ${args.path}`;
  }
});

// 3. 创建主循环
const loop = new MiMoLoop({
  client,
  tools,
  maxTokens: 8000,
  maxSteps: 50,
  workingDirectory: process.cwd()
});

// 4. 执行任务
async function main() {
  for await (const event of loop.run('实现一个斐波那契函数')) {
    switch (event.type) {
      case 'content':
        process.stdout.write(event.content);
        break;
      case 'tool_call':
        console.log(`\n[调用工具] ${event.toolCall.function.name}`);
        break;
      case 'tool_result':
        console.log(`[工具结果] ${event.result.content}`);
        break;
      case 'done':
        console.log(`\n[完成] 成功: ${event.success}`);
        break;
      case 'error':
        console.error(`[错误] ${event.error}`);
        break;
    }
  }
}

main();
```

### 2.2 使用真实MiMo API

```typescript
import { MiMoLoop, ToolRegistry } from 'mimo-coding-optimizer';

// 创建真实的模型客户端
class MiMoClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.mimo.com/v1';
  }

  async chat(options: any) {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: 'mimo-v2.5-pro',
        messages: options.messages,
        tools: options.tools,
        max_tokens: options.max_tokens || 4096
      })
    });

    const data = await response.json();
    return {
      content: data.choices[0].message.content,
      tool_calls: data.choices[0].message.tool_calls,
      usage: data.usage
    };
  }
}

// 使用
const client = new MiMoClient(process.env.MIMO_API_KEY!);
const loop = new MiMoLoop({
  client,
  tools: new ToolRegistry(),
  workingDirectory: '/path/to/project'
});
```

---

## 三、完整配置

### 3.1 配置选项

```typescript
import { 
  MiMoLoop, 
  CodeValidator, 
  ToolCallRepair, 
  CompletenessChecker, 
  ContextManager,
  IterationManager 
} from 'mimo-coding-optimizer';

const loop = new MiMoLoop({
  // 必需配置
  client: mimoClient,
  tools: toolRegistry,
  workingDirectory: '/path/to/project',

  // 可选组件
  validator: new CodeValidator({
    enabledCheckers: ['syntax', 'type', 'pattern']
  }),
  
  toolRepair: new ToolCallRepair(),
  
  completenessChecker: new CompletenessChecker(),
  
  contextManager: new ContextManager({
    foldThreshold: 0.70,        // 上下文折叠阈值
    aggressiveThreshold: 0.75,  // 激进折叠阈值
    tailFraction: 0.25          // 保留最近消息的比例
  }),
  
  iterationManager: new IterationManager({
    maxRetries: 3,              // 最大重试次数
    backoffMs: 1000,            // 重试延迟
    learnFromErrors: true       // 从错误中学习
  }),

  // 性能配置
  maxTokens: 8000,              // 最大token数
  maxSteps: 50,                 // 最大步骤数
  budgetUsd: 10.0               // 预算限制（美元）
});
```

### 3.2 配置文件

创建 `mimo.config.json`:

```json
{
  "model": {
    "provider": "mimo",
    "apiKey": "${MIMO_API_KEY}",
    "maxTokens": 8000,
    "temperature": 0.7
  },
  "tools": {
    "enabled": ["filesystem", "shell", "search"],
    "permissions": {
      "shell": "ask",
      "filesystem": "allow"
    }
  },
  "optimization": {
    "validation": {
      "enabled": true,
      "checkers": ["syntax", "type", "pattern"]
    },
    "repair": {
      "enabled": true,
      "jsonRepair": true,
      "typeRepair": true,
      "pathRepair": true
    },
    "completeness": {
      "enabled": true,
      "checkFunctions": true,
      "checkImports": true
    },
    "context": {
      "foldThreshold": 0.70,
      "strategy": "balanced"
    },
    "iteration": {
      "maxRetries": 3,
      "learnFromErrors": true
    }
  }
}
```

---

## 四、高级用法

### 4.1 自定义检查器

```typescript
import { IChecker, ValidationCheck, ValidationRequest } from 'mimo-coding-optimizer';

class CustomSecurityChecker implements IChecker {
  name = 'security-checker';
  type = 'pattern' as const;

  async check(request: ValidationRequest): Promise<ValidationCheck[]> {
    const checks: ValidationCheck[] = [];
    const content = request.toolResult.content;

    // 检查SQL注入
    if (/SELECT.*FROM.*WHERE/i.test(content) && !content.includes('parameterized')) {
      checks.push({
        name: this.name,
        type: this.type,
        passed: false,
        message: 'Possible SQL injection vulnerability',
        severity: 'error'
      });
    }

    // 检查XSS
    if (/innerHTML|document\.write/i.test(content)) {
      checks.push({
        name: this.name,
        type: this.type,
        passed: false,
        message: 'Possible XSS vulnerability',
        severity: 'warning'
      });
    }

    return checks;
  }
}

// 注册自定义检查器
const validator = new CodeValidator();
validator.registerChecker(new CustomSecurityChecker());
```

### 4.2 监听事件

```typescript
const loop = new MiMoLoop(config);

// 监听所有事件
loop.on('*', (event) => {
  console.log('Event:', event.type);
});

// 监听特定事件
loop.on('tool_call', (event) => {
  console.log('Tool called:', event.toolCall.function.name);
});

loop.on('validation', (event) => {
  if (!event.result.passed) {
    console.log('Validation failed:', event.result.suggestions);
  }
});

// 执行任务
for await (const event of loop.run('任务描述')) {
  // 处理事件
}
```

### 4.3 手动控制流程

```typescript
const loop = new MiMoLoop(config);

// 获取状态
const state = loop.getState();
console.log('Running:', state.running);
console.log('Steps:', state.currentStep);
console.log('Tokens:', state.totalTokens);

// 中断执行
loop.abort();

// 动态配置
loop.configure({
  maxSteps: 100,
  budgetUsd: 20.0
});
```

### 4.4 使用迭代管理器

```typescript
import { IterationManager, ITaskExecutor, IResultValidator } from 'mimo-coding-optimizer';

const manager = new IterationManager({
  maxRetries: 3,
  learnFromErrors: true
});

// 定义任务执行器
const executor: ITaskExecutor = {
  async execute(context, attempt) {
    console.log(`Attempt ${attempt + 1}`);
    // 执行任务逻辑
    return {
      content: '实现代码...',
      success: true
    };
  }
};

// 定义结果验证器
const validator: IResultValidator = {
  async validate(task, result) {
    // 验证结果
    const passed = result.content.includes('function');
    return {
      passed,
      errors: passed ? [] : ['Missing function implementation']
    };
  }
};

// 执行任务
const result = await manager.execute(
  {
    id: 'task-001',
    description: '实现排序算法',
    initialContext: { messages: [] }
  },
  executor,
  validator
);

console.log('Success:', result.success);
console.log('Attempts:', result.attempts);
console.log('Errors:', result.errorHistory);
```

---

## 五、集成到现有项目

### 5.1 集成到CLI工具

```typescript
#!/usr/bin/env node
import { MiMoLoop, CodeValidator, ToolCallRepair } from 'mimo-coding-optimizer';

const args = process.argv.slice(2);
const task = args.join(' ');

if (!task) {
  console.error('Usage: mimo-optimize <task description>');
  process.exit(1);
}

const loop = new MiMoLoop({
  client: createMiMoClient(),
  tools: createToolRegistry(),
  validator: new CodeValidator(),
  toolRepair: new ToolCallRepair(),
  workingDirectory: process.cwd()
});

for await (const event of loop.run(task)) {
  // 输出结果
}
```

### 5.2 集成到VS Code扩展

```typescript
import * as vscode from 'vscode';
import { MiMoLoop, CodeValidator } from 'mimo-coding-optimizer';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('mimo.optimize', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.document.getText(editor.selection);
    
    const loop = new MiMoLoop({
      client: createMiMoClient(),
      tools: createToolRegistry(),
      validator: new CodeValidator(),
      workingDirectory: vscode.workspace.rootPath || ''
    });

    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'MiMo Optimizing...'
    }, async (progress) => {
      for await (const event of loop.run(`优化以下代码:\n${selection}`)) {
        if (event.type === 'content') {
          progress.report({ message: 'Generating...' });
        }
        if (event.type === 'done') {
          // 插入优化后的代码
          editor.edit(builder => {
            builder.replace(editor.selection, event.result || '');
          });
        }
      }
    });
  });

  context.subscriptions.push(disposable);
}
```

---

## 六、故障排除

### 6.1 常见问题

| 问题 | 解决方案 |
|------|----------|
| 类型错误 | 确保TypeScript版本 >= 5.6 |
| 导入错误 | 检查 `package.json` 中的 `type: "module"` |
| 运行时错误 | 启用 `debug: true` 查看详细日志 |

### 6.2 调试模式

```typescript
const loop = new MiMoLoop({
  ...config,
  debug: true  // 启用调试日志
});

// 或设置环境变量
process.env.MIMO_DEBUG = 'true';
```

### 6.3 性能调优

```typescript
// 减少上下文折叠频率
const contextManager = new ContextManager({
  foldThreshold: 0.80  // 提高阈值
});

// 减少重试次数
const iterationManager = new IterationManager({
  maxRetries: 1  // 减少重试
});

// 限制token使用
const loop = new MiMoLoop({
  maxTokens: 4000,  // 减少token限制
  maxSteps: 20      // 减少步骤限制
});
```

---

## 七、API参考

### 7.1 MiMoLoop

| 方法 | 参数 | 返回值 | 描述 |
|------|------|--------|------|
| `run(task)` | `string` | `AsyncGenerator<LoopEvent>` | 执行任务 |
| `step(context)` | `TaskContext` | `Promise<boolean>` | 执行单步 |
| `abort()` | - | `void` | 中断执行 |
| `getState()` | - | `LoopState` | 获取状态 |
| `configure(config)` | `Partial<MiMoLoopConfig>` | `void` | 更新配置 |
| `on(type, listener)` | `string, Function` | `void` | 监听事件 |

### 7.2 CodeValidator

| 方法 | 参数 | 返回值 | 描述 |
|------|------|--------|------|
| `validate(request)` | `ValidationRequest` | `Promise<ValidationResult>` | 验证代码 |
| `registerChecker(checker)` | `IChecker` | `void` | 注册检查器 |
| `setCheckerEnabled(type, enabled)` | `string, boolean` | `void` | 启用/禁用检查器 |

### 7.3 ToolCallRepair

| 方法 | 参数 | 返回值 | 描述 |
|------|------|--------|------|
| `repair(request)` | `RepairRequest` | `Promise<RepairResult>` | 修复工具调用 |
| `repairJson(json)` | `string` | `JsonRepairResult` | 修复JSON |
| `repairArgTypes(args, schema)` | `Record, ToolSchema` | `Record` | 修复参数类型 |
| `repairPath(path, context)` | `string, RepairContext` | `string` | 修复路径 |

### 7.4 CompletenessChecker

| 方法 | 参数 | 返回值 | 描述 |
|------|------|--------|------|
| `check(request)` | `CompletenessRequest` | `Promise<CompletenessResult>` | 检查完整性 |
| `checkFunctionCompleteness(code)` | `string` | `Promise<CompletenessIssue[]>` | 检查函数 |
| `checkImportCompleteness(code, context)` | `string, CodeContext` | `Promise<CompletenessIssue[]>` | 检查导入 |

### 7.5 ContextManager

| 方法 | 参数 | 返回值 | 描述 |
|------|------|--------|------|
| `optimize(request)` | `ContextOptimizeRequest` | `Promise<ContextOptimizeResult>` | 优化上下文 |
| `extractKeyInfo(messages, state)` | `ChatMessage[], TaskState` | `Promise<KeyInfo>` | 提取关键信息 |
| `countTokens(messages)` | `ChatMessage[]` | `number` | 计算token |

### 7.6 IterationManager

| 方法 | 参数 | 返回值 | 描述 |
|------|------|--------|------|
| `execute(task, executor, validator)` | `IterationTask, ITaskExecutor, IResultValidator` | `Promise<IterationResult>` | 执行迭代任务 |
| `getErrorHistory(taskId)` | `string` | `ErrorRecord[]` | 获取错误历史 |
| `getFixHistory(taskId)` | `string` | `FixRecord[]` | 获取修复历史 |
| `findSimilarFixes(problem)` | `string` | `FixRecord[]` | 查找相似修复 |

---

**文档版本**: 1.0.0  
**最后更新**: 2026-05-27