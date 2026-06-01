# Minimum - 完整功能清单

## 项目统计

| 项目 | 值 |
|------|-----|
| 源文件数 | 81 |
| 构建输出 | `dist/index.js` (96.42 KB) |
| 类型定义 | `dist/index.d.ts` (45.73 KB) |
| 构建状态 | ✅ 成功 |

---

## 一、核心优化模块

### 1.1 CodeValidator (代码验证器)
```typescript
import { CodeValidator } from 'minimum';
const validator = new CodeValidator();
```

| 检查器 | 功能 |
|--------|------|
| SyntaxChecker | JSON/TS/JS/Python语法检查 |
| TypeChecker | 类型错误检测 |
| PatternChecker | 模式匹配检查 |

### 1.2 ToolCallRepair (工具调用修复)
```typescript
import { ToolCallRepair } from 'minimum';
const repair = new ToolCallRepair();
```

| 修复器 | 功能 |
|--------|------|
| JsonRepair | JSON截断修复 |
| TypeRepair | 类型不匹配修复 |
| ValueRepair | 参数值修复 |
| PathRepair | 路径规范化 |

### 1.3 CompletenessChecker (完整性检查)
```typescript
import { CompletenessChecker } from 'minimum';
const checker = new CompletenessChecker();
```

| 检查器 | 功能 |
|--------|------|
| FunctionChecker | 函数完整性检查 |
| ImportChecker | 导入完整性检查 |
| ErrorHandlingChecker | 错误处理检查 |
| TaskCompletionChecker | 任务完成度检查 |

### 1.4 ContextManager (上下文管理)
```typescript
import { ContextManager } from 'minimum';
const manager = new ContextManager();
```

| 组件 | 功能 |
|------|------|
| KeyInfoExtractor | 关键信息提取 |
| MessageFolder | 消息折叠 |
| SummaryGenerator | 摘要生成 |

### 1.5 IterationManager (迭代管理)
```typescript
import { IterationManager } from 'minimum';
const manager = new IterationManager();
```

| 组件 | 功能 |
|------|------|
| ErrorRecorder | 错误记录 |
| FixRecorder | 修复记录 |
| RetryStrategy | 重试策略 |

### 1.6 MiMoLoop (主循环)
```typescript
import { MiMoLoop } from 'minimum';
const loop = new MiMoLoop({ ... });
```

---

## 二、API客户端

### 2.1 MiMoClient
```typescript
import { MiMoClient } from 'minimum';
const client = new MiMoClient({
  apiKey: 'your-api-key',
  model: 'mimo-v2.5-pro'
});
```

| 方法 | 功能 |
|------|------|
| `chat()` | 非流式对话 |
| `streamChat()` | 流式对话 |

---

## 三、工具系统

### 3.1 ToolRegistry (工具注册表)
```typescript
import { ToolRegistry } from 'minimum';
const registry = new ToolRegistry();
registry.register(tool);
```

### 3.2 文件系统工具
```typescript
import { ReadFileTool, WriteFileTool, EditFileTool, GlobTool, ListDirectoryTool } from 'minimum';
```

| 工具 | 功能 |
|------|------|
| ReadFileTool | 读取文件（支持行范围） |
| WriteFileTool | 写入文件（支持创建目录） |
| EditFileTool | SEARCH/REPLACE编辑 |
| GlobTool | Glob模式搜索 |
| ListDirectoryTool | 列出目录内容 |

### 3.3 Shell工具
```typescript
import { ExecShellTool } from 'minimum';
```

| 工具 | 功能 |
|------|------|
| ExecShellTool | 执行Shell命令（支持超时） |

### 3.4 Git工具
```typescript
import { GitTool, GitStatusTool, GitDiffTool, GitLogTool } from 'minimum';
```

| 工具 | 功能 |
|------|------|
| GitTool | 通用Git命令 |
| GitStatusTool | Git状态 |
| GitDiffTool | Git差异 |
| GitLogTool | Git日志 |

### 3.5 搜索工具
```typescript
import { GrepTool, SearchTool } from 'minimum';
```

| 工具 | 功能 |
|------|------|
| GrepTool | 正则表达式搜索 |
| SearchTool | 文件和内容搜索 |

---

## 四、记忆系统

### 4.1 MemoryStore (通用记忆)
```typescript
import { MemoryStore } from 'minimum';
const store = new MemoryStore();
await store.initialize();
await store.set({ key: 'preference', value: 'dark mode', type: 'user' });
```

### 4.2 SessionMemory (会话记忆)
```typescript
import { SessionMemory } from 'minimum';
const session = new SessionMemory();
await session.createSession();
await session.addMessage({ role: 'user', content: 'Hello' });
```

### 4.3 ProjectMemory (项目记忆)
```typescript
import { ProjectMemory } from 'minimum';
const memory = new ProjectMemory('/path/to/project');
await memory.initialize();
await memory.set('convention', 'Use TypeScript strict mode');
```

---

## 五、Skills系统

### 5.1 SkillRegistry (技能注册表)
```typescript
import { SkillRegistry, registerBuiltinSkills } from 'minimum';
const registry = new SkillRegistry();
registerBuiltinSkills(registry);
```

### 5.2 内置技能
```typescript
import { CodeReviewSkill, RefactorSkill, TestGeneratorSkill, DocumentationSkill } from 'minimum';
```

| 技能 | 功能 |
|------|------|
| CodeReviewSkill | 代码审查 |
| RefactorSkill | 重构建议 |
| TestGeneratorSkill | 测试生成 |
| DocumentationSkill | 文档生成 |

### 5.3 SkillLoader (技能加载器)
```typescript
import { SkillLoader } from 'minimum';
const loader = new SkillLoader(registry);
await loader.loadFromDirectory('/path/to/skills');
```

---

## 六、工具函数

### 6.1 JSON修复
```typescript
import { repairTruncatedJson, balanceBrackets, removeTrailingComma } from 'minimum';
```

### 6.2 路径工具
```typescript
import { normalizePath, toAbsolutePath, isPathInside, detectLanguage } from 'minimum';
```

### 6.3 Token计算
```typescript
import { estimateTokens, countMessagesTokens, truncateToTokens } from 'minimum';
```

### 6.4 字符串相似度
```typescript
import { levenshteinSimilarity, jaccardSimilarity, findMostSimilar } from 'minimum';
```

### 6.5 语法检查
```typescript
import { checkJsonSyntax, checkTypeScriptSyntax, checkPythonSyntax } from 'minimum';
```

---

## 七、Mock测试工具

```typescript
import {
  MockClient,
  MockToolRegistry,
  MockValidator,
  MockCompletenessChecker,
  MockContextManager,
  MockIterationManager,
  MockRepair
} from 'minimum';
```

---

## 八、CLI命令

| 命令 | 功能 |
|------|------|
| `minimum` | 启动交互式TUI |
| `minimum --help` | 显示帮助 |
| `minimum --version` | 显示版本 |

---

## 九、使用示例

### 9.1 完整使用示例

```typescript
import {
  MiMoClient,
  ToolRegistry,
  MiMoLoop,
  CodeValidator,
  ToolCallRepair,
  CompletenessChecker,
  ContextManager,
  IterationManager,
  ReadFileTool,
  WriteFileTool,
  ExecShellTool,
  GitTool,
  MemoryStore
} from 'minimum';

// 1. 创建客户端
const client = new MiMoClient({
  apiKey: process.env.MIMO_API_KEY
});

// 2. 注册工具
const tools = new ToolRegistry();
tools.register(new ReadFileTool());
tools.register(new WriteFileTool());
tools.register(new ExecShellTool());
tools.register(new GitTool());

// 3. 创建优化组件
const validator = new CodeValidator();
const toolRepair = new ToolCallRepair();
const completenessChecker = new CompletenessChecker();
const contextManager = new ContextManager();
const iterationManager = new IterationManager();

// 4. 创建主循环
const loop = new MiMoLoop({
  client,
  tools,
  validator,
  toolRepair,
  completenessChecker,
  contextManager,
  iterationManager,
  workingDirectory: process.cwd()
});

// 5. 执行任务
for await (const event of loop.run('实现快速排序算法')) {
  switch (event.type) {
    case 'content':
      process.stdout.write(event.content);
      break;
    case 'tool_call':
      console.log(`Calling: ${event.toolCall.function.name}`);
      break;
    case 'done':
      console.log('Task completed!');
      break;
  }
}
```

### 9.2 记忆系统使用

```typescript
import { SessionMemory, ProjectMemory, MemoryStore } from 'minimum';

// 会话记忆
const session = new SessionMemory();
await session.createSession();
await session.addMessage({ role: 'user', content: 'Hello' });

// 项目记忆
const project = new ProjectMemory('/path/to/project');
await project.set('style', 'Use 4 spaces for indentation');

// 通用记忆
const store = new MemoryStore();
await store.set({
  key: 'preference',
  value: 'dark mode',
  type: 'user'
});
```

### 9.3 Skills系统使用

```typescript
import { SkillRegistry, registerBuiltinSkills, SkillLoader } from 'minimum';

// 注册内置技能
const registry = new SkillRegistry();
registerBuiltinSkills(registry);

// 加载自定义技能
const loader = new SkillLoader(registry);
await loader.loadFromDirectory('./skills');

// 执行技能
const result = await registry.execute('code-review', {
  workingDirectory: process.cwd(),
  projectRoot: process.cwd(),
  variables: {}
});
```

---

## 十、配置文件

### 10.1 minimum.config.json

```json
{
  "model": {
    "provider": "mimo",
    "apiKey": "${MIMO_API_KEY}",
    "model": "mimo-v2.5-pro"
  },
  "tools": {
    "enabled": ["filesystem", "shell", "git", "search"]
  },
  "memory": {
    "enabled": true,
    "path": "~/.minimum/memory"
  },
  "skills": {
    "enabled": true,
    "path": "./skills"
  },
  "optimization": {
    "validation": true,
    "repair": true,
    "completeness": true,
    "context": {
      "foldThreshold": 0.70
    },
    "iteration": {
      "maxRetries": 3
    }
  }
}
```

---

**文档版本**: 2.0.0  
**最后更新**: 2026-05-27