# MiMo Coding 体验优化方案

## 基于 DeepSeek V4 Pro vs MiMo V2.5 Pro 对比分析

---

## 一、问题诊断

### 1.1 MiMo 的核心弱点

| 维度 | MiMo 表现 | DeepSeek 表现 | 差距 | 根因分析 |
|------|-----------|---------------|------|----------|
| EvoCode-Bench MT@4 | 17.3 | 30.6 | **-43%** | 多轮迭代稳定性差，首轮失败占比高 |
| RoadmapBench | 13.9% | 18.3% | **-24%** | Code Defect + 部分实现 |
| FIM补全 | 无 | 有 | **缺失** | 不支持代码中间补全 |
| IDE生态 | 较少 | 广泛 | **差距** | 工具接入面窄 |

### 1.2 MiMo 的失效模式分析

根据RoadmapBench作者的观察：

```
DeepSeek 失效模式: 架构规划较强、执行精度略差
MiMo 失效模式: Code Defect + 部分实现
```

**Code Defect** 的典型表现：
- 变量名错误、类型不匹配
- 边界条件处理不当
- API调用参数错误
- 逻辑分支遗漏

**部分实现** 的典型表现：
- 函数只实现了一半
- 遗漏了错误处理
- 缺少必要的import
- 测试用例不完整

### 1.3 优化策略

针对MiMo的弱点，需要在TUI层面做以下优化：

1. **增强代码验证** - 减少Code Defect
2. **强制完整性检查** - 减少部分实现
3. **改善多轮迭代** - 提高EvoCode-Bench分数
4. **优化上下文管理** - 支持长轨迹任务

---

## 二、定向优化方案

### 2.1 增强代码验证 - 减少Code Defect

参考DeepSeek-Reasonix的repair机制和CodeWhale的LSP集成：

```typescript
// src/core/code-validator.ts

/**
 * 代码验证器 - 针对MiMo的Code Defect问题
 * 
 * MiMo常见缺陷：
 * 1. 变量名错误
 * 2. 类型不匹配
 * 3. API参数错误
 * 4. 边界条件遗漏
 */
export class CodeValidator {
  /**
   * 验证工具调用结果
   * 在工具执行后、返回给模型前进行验证
   */
  async validateToolResult(
    toolName: string,
    args: Record<string, any>,
    result: ToolResult
  ): Promise<ValidationResult> {
    const checks: ValidationCheck[] = [];

    // 1. 文件写入后验证
    if (['write_file', 'edit_file', 'apply_patch'].includes(toolName)) {
      checks.push(...await this.validateFileWrite(args, result));
    }

    // 2. Shell执行后验证
    if (toolName === 'exec_shell') {
      checks.push(...await this.validateShellResult(args, result));
    }

    // 3. 代码生成验证
    if (this.isCodeGeneration(toolName)) {
      checks.push(...await this.validateGeneratedCode(args, result));
    }

    return {
      passed: checks.every(c => c.passed),
      checks,
      suggestions: this.generateSuggestions(checks)
    };
  }

  /**
   * 验证文件写入
   */
  private async validateFileWrite(
    args: Record<string, any>,
    result: ToolResult
  ): Promise<ValidationCheck[]> {
    const checks: ValidationCheck[] = [];
    const filePath = args.path;
    const content = args.content;

    // 1. 语法检查
    const syntaxCheck = await this.checkSyntax(filePath, content);
    checks.push(syntaxCheck);

    // 2. 类型检查（如果有LSP）
    const typeCheck = await this.checkTypes(filePath, content);
    if (typeCheck) checks.push(typeCheck);

    // 3. 常见模式检查
    const patternChecks = await this.checkCommonPatterns(content);
    checks.push(...patternChecks);

    return checks;
  }

  /**
   * 检查常见错误模式
   */
  private async checkCommonPatterns(content: string): Promise<ValidationCheck[]> {
    const checks: ValidationCheck[] = [];

    // 1. 未定义变量检查
    const undefinedVars = this.findUndefinedVariables(content);
    if (undefinedVars.length > 0) {
      checks.push({
        name: 'undefined-variables',
        passed: false,
        message: `可能使用了未定义的变量: ${undefinedVars.join(', ')}`,
        severity: 'warning'
      });
    }

    // 2. 未使用的import检查
    const unusedImports = this.findUnusedImports(content);
    if (unusedImports.length > 0) {
      checks.push({
        name: 'unused-imports',
        passed: false,
        message: `未使用的import: ${unusedImports.join(', ')}`,
        severity: 'info'
      });
    }

    // 3. 缺少错误处理检查
    const missingErrorHandling = this.checkErrorHandling(content);
    if (missingErrorHandling) {
      checks.push({
        name: 'error-handling',
        passed: false,
        message: '可能缺少错误处理',
        severity: 'warning'
      });
    }

    // 4. 边界条件检查
    const boundaryIssues = this.checkBoundaryConditions(content);
    if (boundaryIssues.length > 0) {
      checks.push({
        name: 'boundary-conditions',
        passed: false,
        message: `边界条件问题: ${boundaryIssues.join(', ')}`,
        severity: 'warning'
      });
    }

    return checks;
  }

  /**
   * 生成修复建议
   */
  private generateSuggestions(checks: ValidationCheck[]): string[] {
    const suggestions: string[] = [];

    for (const check of checks) {
      if (!check.passed) {
        switch (check.name) {
          case 'undefined-variables':
            suggestions.push('请检查变量是否已声明或正确导入');
            break;
          case 'syntax-error':
            suggestions.push('请修复语法错误后再继续');
            break;
          case 'type-error':
            suggestions.push('请检查类型是否匹配');
            break;
          case 'error-handling':
            suggestions.push('建议添加try-catch或错误处理逻辑');
            break;
        }
      }
    }

    return suggestions;
  }
}
```

### 2.2 强制完整性检查 - 减少部分实现

```typescript
// src/core/completeness-checker.ts

/**
 * 完整性检查器 - 针对MiMo的部分实现问题
 * 
 * MiMo常见问题：
 * 1. 函数只实现了一半
 * 2. 遗漏了错误处理
 * 3. 缺少必要的import
 * 4. 测试用例不完整
 */
export class CompletenessChecker {
  /**
   * 检查代码完整性
   */
  async checkCompleteness(
    task: string,
    generatedCode: string,
    context: CodeContext
  ): Promise<CompletenessReport> {
    const issues: CompletenessIssue[] = [];

    // 1. 检查函数完整性
    issues.push(...await this.checkFunctionCompleteness(generatedCode));

    // 2. 检查import完整性
    issues.push(...await this.checkImportCompleteness(generatedCode, context));

    // 3. 检查错误处理完整性
    issues.push(...await this.checkErrorHandlingCompleteness(generatedCode));

    // 4. 检查测试完整性
    if (this.isTestTask(task)) {
      issues.push(...await this.checkTestCompleteness(generatedCode));
    }

    // 5. 检查任务完成度
    issues.push(...await this.checkTaskCompletion(task, generatedCode));

    return {
      complete: issues.filter(i => i.severity === 'error').length === 0,
      issues,
      score: this.calculateCompletenessScore(issues),
      suggestions: this.generateCompletionSuggestions(issues)
    };
  }

  /**
   * 检查函数完整性
   */
  private async checkFunctionCompleteness(code: string): Promise<CompletenessIssue[]> {
    const issues: CompletenessIssue[] = [];

    // 查找所有函数定义
    const functions = this.extractFunctions(code);

    for (const func of functions) {
      // 检查是否有TODO/FIXME标记
      if (func.body.includes('TODO') || func.body.includes('FIXME')) {
        issues.push({
          type: 'incomplete-function',
          severity: 'error',
          message: `函数 ${func.name} 包含TODO/FIXME标记，可能未完成`,
          location: func.location
        });
      }

      // 检查是否有占位符代码
      if (this.hasPlaceholderCode(func.body)) {
        issues.push({
          type: 'placeholder-code',
          severity: 'error',
          message: `函数 ${func.name} 包含占位符代码`,
          location: func.location
        });
      }

      // 检查是否有空函数体
      if (this.isEmptyFunction(func.body)) {
        issues.push({
          type: 'empty-function',
          severity: 'warning',
          message: `函数 ${func.name} 函数体为空`,
          location: func.location
        });
      }

      // 检查返回值
      if (func.returnType && !this.hasReturnValue(func.body)) {
        issues.push({
          type: 'missing-return',
          severity: 'error',
          message: `函数 ${func.name} 声明有返回值但可能缺少return语句`,
          location: func.location
        });
      }
    }

    return issues;
  }

  /**
   * 检查任务完成度
   */
  private async checkTaskCompletion(
    task: string,
    code: string
  ): Promise<CompletenessIssue[]> {
    const issues: CompletenessIssue[] = [];

    // 使用MiMo模型检查任务完成度
    const completionCheck = await this.mimo.chat({
      messages: [
        {
          role: 'system',
          content: `分析以下代码是否完成了指定的任务。检查：
1. 所有要求的功能是否都实现了
2. 是否有遗漏的部分
3. 是否有未处理的边界情况

返回JSON格式的检查结果。`
        },
        {
          role: 'user',
          content: `任务: ${task}\n\n代码:\n${code}`
        }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(completionCheck.content);

    if (result.missing_features) {
      for (const feature of result.missing_features) {
        issues.push({
          type: 'missing-feature',
          severity: 'error',
          message: `未实现功能: ${feature}`,
          location: null
        });
      }
    }

    if (result.incomplete_parts) {
      for (const part of result.incomplete_parts) {
        issues.push({
          type: 'incomplete-part',
          severity: 'warning',
          message: `可能不完整: ${part}`,
          location: null
        });
      }
    }

    return issues;
  }

  /**
   * 生成完成建议
   */
  private generateCompletionSuggestions(issues: CompletenessIssue[]): string[] {
    const suggestions: string[] = [];

    const errorIssues = issues.filter(i => i.severity === 'error');
    const warningIssues = issues.filter(i => i.severity === 'warning');

    if (errorIssues.length > 0) {
      suggestions.push(`发现 ${errorIssues.length} 个严重问题需要修复:`);
      for (const issue of errorIssues) {
        suggestions.push(`  - ${issue.message}`);
      }
    }

    if (warningIssues.length > 0) {
      suggestions.push(`发现 ${warningIssues.length} 个警告:`);
      for (const issue of warningIssues) {
        suggestions.push(`  - ${issue.message}`);
      }
    }

    if (errorIssues.length > 0) {
      suggestions.push('建议: 请修复上述错误后再继续');
    }

    return suggestions;
  }
}
```

### 2.3 改善多轮迭代 - 提高EvoCode-Bench分数

参考DeepSeek-Reasonix的ContextManager和CodeWhale的CycleManager：

```typescript
// src/core/iteration-manager.ts

/**
 * 迭代管理器 - 针对MiMo的多轮迭代问题
 * 
 * 问题：EvoCode-Bench MT@4 17.3 vs DeepSeek 30.6
 * 根因：首轮失败占比高，迭代修正能力弱
 * 
 * 优化策略：
 * 1. 失败后自动重试
 * 2. 增量式修复
 * 3. 上下文保持
 * 4. 错误学习
 */
export class IterationManager {
  private maxRetries: number = 3;
  private errorHistory: ErrorRecord[] = [];
  private fixHistory: FixRecord[] = [];

  /**
   * 执行带重试的任务
   */
  async executeWithRetry(
    task: string,
    context: TaskContext
  ): Promise<TaskResult> {
    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt < this.maxRetries) {
      try {
        // 1. 执行任务
        const result = await this.executeTask(task, context, attempt);

        // 2. 验证结果
        const validation = await this.validateResult(task, result);

        if (validation.passed) {
          // 成功，记录修复历史
          if (attempt > 0) {
            this.recordFix(task, lastError!, result);
          }
          return result;
        }

        // 3. 验证失败，准备重试
        lastError = new Error(validation.errors.join(', '));
        this.recordError(task, lastError, attempt);

        // 4. 生成修复提示
        const fixPrompt = this.generateFixPrompt(
          task,
          result,
          validation.errors,
          attempt
        );

        // 5. 更新上下文
        context.messages.push({
          role: 'assistant',
          content: result.content
        });
        context.messages.push({
          role: 'user',
          content: fixPrompt
        });

        attempt++;

      } catch (error) {
        lastError = error as Error;
        this.recordError(task, lastError, attempt);
        attempt++;
      }
    }

    // 所有重试都失败
    throw new TaskFailedError(
      `任务在 ${this.maxRetries} 次尝试后仍然失败`,
      lastError
    );
  }

  /**
   * 生成修复提示
   */
  private generateFixPrompt(
    task: string,
    failedResult: TaskResult,
    errors: string[],
    attempt: number
  ): string {
    // 收集相关的历史修复经验
    const relevantFixes = this.findRelevantFixes(task, errors);

    let prompt = `之前的实现有问题，请修复：

错误信息:
${errors.map(e => `- ${e}`).join('\n')}

之前的代码:
\`\`\`
${failedResult.content}
\`\`\`
`;

    // 添加历史修复经验
    if (relevantFixes.length > 0) {
      prompt += `
类似的修复经验:
${relevantFixes.map(f => `- ${f.description}`).join('\n')}
`;
    }

    // 添加特定于尝试次数的提示
    if (attempt === 1) {
      prompt += `
请仔细检查：
1. 是否有语法错误
2. 是否有类型错误
3. 是否有逻辑错误
`;
    } else if (attempt === 2) {
      prompt += `
这是第3次尝试，请：
1. 重新审视任务需求
2. 检查是否有遗漏的功能
3. 考虑边界条件
`;
    }

    return prompt;
  }

  /**
   * 记录错误
   */
  private recordError(task: string, error: Error, attempt: number): void {
    this.errorHistory.push({
      task,
      error: error.message,
      attempt,
      timestamp: Date.now(),
      stack: error.stack
    });
  }

  /**
   * 记录修复
   */
  private recordFix(task: string, error: Error, fix: TaskResult): void {
    this.fixHistory.push({
      task,
      error: error.message,
      fix: fix.content,
      timestamp: Date.now()
    });
  }

  /**
   * 查找相关的修复经验
   */
  private findRelevantFixes(task: string, errors: string[]): FixRecord[] {
    return this.fixHistory.filter(fix => {
      // 检查任务相似度
      const taskSimilarity = this.calculateSimilarity(task, fix.task);
      if (taskSimilarity > 0.7) return true;

      // 检查错误相似度
      for (const error of errors) {
        const errorSimilarity = this.calculateSimilarity(error, fix.error);
        if (errorSimilarity > 0.8) return true;
      }

      return false;
    });
  }
}
```

### 2.4 优化上下文管理 - 支持长轨迹任务

参考DeepSeek-Reasonix的ContextManager：

```typescript
// src/core/enhanced-context-manager.ts

/**
 * 增强的上下文管理器 - 针对MiMo的长轨迹任务
 * 
 * 问题：RoadmapBench表现不佳，长地平线任务容易丢失上下文
 * 
 * 优化策略：
 * 1. 智能上下文压缩
 * 2. 关键信息保持
 * 3. 任务状态跟踪
 * 4. 增量式更新
 */
export class EnhancedContextManager {
  // 参考DeepSeek-Reasonix的阈值
  private readonly FOLD_THRESHOLD = 0.70;  // 比DeepSeek更保守
  private readonly AGGRESSIVE_THRESHOLD = 0.75;
  private readonly FORCE_SUMMARY_THRESHOLD = 0.80;

  // MiMo特有：更积极地保持关键信息
  private readonly KEY_INFO_RETENTION_RATIO = 0.3;

  /**
   * 优化上下文
   */
  async optimizeForLongTask(
    messages: ChatMessage[],
    taskState: TaskState,
    maxTokens: number
  ): Promise<OptimizedContext> {
    const currentTokens = this.countTokens(messages);
    const ratio = currentTokens / maxTokens;

    // 1. 如果在安全范围内，直接返回
    if (ratio < this.FOLD_THRESHOLD) {
      return {
        messages,
        folded: false,
        retainedInfo: null
      };
    }

    // 2. 提取关键信息
    const keyInfo = await this.extractKeyInfo(messages, taskState);

    // 3. 折叠旧消息
    const folded = await this.foldMessages(
      messages,
      keyInfo,
      ratio > this.AGGRESSIVE_THRESHOLD ? 'aggressive' : 'normal'
    );

    // 4. 确保关键信息保留
    const finalMessages = await this.ensureKeyInfoRetention(
      folded,
      keyInfo,
      maxTokens
    );

    return {
      messages: finalMessages,
      folded: true,
      retainedInfo: keyInfo
    };
  }

  /**
   * 提取关键信息
   * 
   * MiMo特有优化：更积极地提取和保留关键信息
   */
  private async extractKeyInfo(
    messages: ChatMessage[],
    taskState: TaskState
  ): Promise<KeyInfo> {
    const keyInfo: KeyInfo = {
      taskObjective: taskState.objective,
      decisions: [],
      fileChanges: [],
      errors: [],
      partialResults: [],
      constraints: []
    };

    // 1. 提取决策
    for (const msg of messages) {
      if (msg.role === 'assistant' && this.containsDecision(msg.content)) {
        keyInfo.decisions.push(this.extractDecision(msg.content));
      }
    }

    // 2. 提取文件变更
    for (const msg of messages) {
      if (msg.role === 'tool' && this.isFileOperation(msg)) {
        keyInfo.fileChanges.push(this.extractFileChange(msg));
      }
    }

    // 3. 提取错误和修复
    for (const msg of messages) {
      if (this.isError(msg)) {
        keyInfo.errors.push(this.extractError(msg));
      }
    }

    // 4. 提取约束条件
    for (const msg of messages) {
      if (this.containsConstraint(msg.content)) {
        keyInfo.constraints.push(this.extractConstraint(msg.content));
      }
    }

    // 5. 使用MiMo模型提取关键信息（可选）
    if (messages.length > 20) {
      const extracted = await this.extractWithModel(messages);
      keyInfo.partialResults.push(...extracted);
    }

    return keyInfo;
  }

  /**
   * 折叠消息
   */
  private async foldMessages(
    messages: ChatMessage[],
    keyInfo: KeyInfo,
    mode: 'normal' | 'aggressive'
  ): Promise<ChatMessage[]> {
    // 分离系统消息和历史消息
    const systemMessages = messages.filter(m => m.role === 'system');
    const historyMessages = messages.filter(m => m.role !== 'system');

    // 计算保留的消息数量
    const tailFraction = mode === 'aggressive' ? 0.15 : 0.25;
    const tailCount = Math.floor(historyMessages.length * tailFraction);

    // 保留最近的消息
    const recentMessages = historyMessages.slice(-tailCount);
    const oldMessages = historyMessages.slice(0, -tailCount);

    // 生成摘要（包含关键信息）
    const summary = await this.generateSummary(oldMessages, keyInfo);

    // 构建折叠后的消息列表
    const summaryMessage: ChatMessage = {
      role: 'assistant',
      content: this.formatSummary(summary, keyInfo)
    };

    return [...systemMessages, summaryMessage, ...recentMessages];
  }

  /**
   * 格式化摘要
   * 
   * MiMo特有优化：更结构化的摘要格式
   */
  private formatSummary(summary: string, keyInfo: KeyInfo): string {
    let formatted = `[上下文折叠 - 任务进行中]\n\n`;

    // 1. 任务目标
    formatted += `## 任务目标\n${keyInfo.taskObjective}\n\n`;

    // 2. 关键决策
    if (keyInfo.decisions.length > 0) {
      formatted += `## 关键决策\n`;
      for (const decision of keyInfo.decisions) {
        formatted += `- ${decision}\n`;
      }
      formatted += '\n';
    }

    // 3. 文件变更
    if (keyInfo.fileChanges.length > 0) {
      formatted += `## 文件变更\n`;
      for (const change of keyInfo.fileChanges) {
        formatted += `- ${change.file}: ${change.description}\n`;
      }
      formatted += '\n';
    }

    // 4. 遇到的问题
    if (keyInfo.errors.length > 0) {
      formatted += `## 遇到的问题\n`;
      for (const error of keyInfo.errors) {
        formatted += `- ${error.message} (${error.resolved ? '已解决' : '未解决'})\n`;
      }
      formatted += '\n';
    }

    // 5. 约束条件
    if (keyInfo.constraints.length > 0) {
      formatted += `## 约束条件\n`;
      for (const constraint of keyInfo.constraints) {
        formatted += `- ${constraint}\n`;
      }
      formatted += '\n';
    }

    // 6. 对话摘要
    formatted += `## 对话摘要\n${summary}\n`;

    return formatted;
  }
}
```

### 2.5 工具调用准确性优化

参考DeepSeek-Reasonix的repair机制：

```typescript
// src/core/mimo-repair.ts

/**
 * MiMo专用工具调用修复器
 * 
 * 针对MiMo的特点进行优化：
 * 1. 更积极的参数验证
 * 2. 更好的错误恢复
 * 3. 更准确的类型推断
 */
export class MiMoToolRepair {
  /**
   * 修复工具调用
   */
  async repair(
    toolCall: ToolCall,
    context: RepairContext
  ): Promise<RepairResult> {
    const repairs: Repair[] = [];

    // 1. JSON修复（参考DeepSeek-Reasonix的truncation repair）
    const jsonRepair = this.repairJson(toolCall.function.arguments);
    if (jsonRepair.changed) {
      repairs.push({
        type: 'json-repair',
        description: jsonRepair.description,
        before: toolCall.function.arguments,
        after: jsonRepair.repaired
      });
      toolCall.function.arguments = jsonRepair.repaired;
    }

    // 2. 参数类型修复（MiMo特有）
    const typeRepair = await this.repairArgTypes(toolCall, context);
    if (typeRepair.changed) {
      repairs.push({
        type: 'type-repair',
        description: typeRepair.description,
        before: typeRepair.before,
        after: typeRepair.after
      });
    }

    // 3. 参数值修复（MiMo特有）
    const valueRepair = await this.repairArgValues(toolCall, context);
    if (valueRepair.changed) {
      repairs.push({
        type: 'value-repair',
        description: valueRepair.description,
        before: valueRepair.before,
        after: valueRepair.after
      });
    }

    // 4. 路径修复
    if (this.isFileSystemTool(toolCall.function.name)) {
      const pathRepair = this.repairPaths(toolCall, context);
      if (pathRepair.changed) {
        repairs.push({
          type: 'path-repair',
          description: pathRepair.description,
          before: pathRepair.before,
          after: pathRepair.after
        });
      }
    }

    return {
      toolCall,
      repairs,
      hasRepairs: repairs.length > 0
    };
  }

  /**
   * 修复参数类型
   * 
   * MiMo常见问题：字符串/数字类型混淆
   */
  private async repairArgTypes(
    toolCall: ToolCall,
    context: RepairContext
  ): Promise<TypeRepairResult> {
    const args = JSON.parse(toolCall.function.arguments);
    const schema = context.toolSchemas[toolCall.function.name];

    if (!schema) {
      return { changed: false };
    }

    let changed = false;
    const before = JSON.stringify(args);

    // 检查每个参数的类型
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (!(key in args)) continue;

      const value = args[key];
      const expectedType = (propSchema as any).type;

      // 修复类型不匹配
      if (expectedType === 'number' && typeof value === 'string') {
        const parsed = Number(value);
        if (!isNaN(parsed)) {
          args[key] = parsed;
          changed = true;
        }
      } else if (expectedType === 'string' && typeof value === 'number') {
        args[key] = String(value);
        changed = true;
      } else if (expectedType === 'boolean' && typeof value === 'string') {
        if (value === 'true') {
          args[key] = true;
          changed = true;
        } else if (value === 'false') {
          args[key] = false;
          changed = true;
        }
      }
    }

    return {
      changed,
      description: changed ? '修复了参数类型不匹配' : '',
      before: changed ? before : '',
      after: changed ? JSON.stringify(args) : ''
    };
  }

  /**
   * 修复参数值
   * 
   * MiMo常见问题：参数值不合理
   */
  private async repairArgValues(
    toolCall: ToolCall,
    context: RepairContext
  ): Promise<ValueRepairResult> {
    const args = JSON.parse(toolCall.function.arguments);
    let changed = false;
    const before = JSON.stringify(args);

    // 1. 修复空字符串
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.trim() === '') {
        // 某些参数不应该为空
        if (this.isRequiredNonEmpty(toolCall.function.name, key)) {
          // 使用默认值或从上下文推断
          const inferred = await this.inferValue(key, context);
          if (inferred) {
            args[key] = inferred;
            changed = true;
          }
        }
      }
    }

    // 2. 修复路径
    if (args.path && typeof args.path === 'string') {
      // 移除多余的斜杠
      const fixedPath = args.path.replace(/\/+/g, '/');
      if (fixedPath !== args.path) {
        args.path = fixedPath;
        changed = true;
      }
    }

    return {
      changed,
      description: changed ? '修复了参数值' : '',
      before: changed ? before : '',
      after: changed ? JSON.stringify(args) : ''
    };
  }
}
```

---

## 三、TUI集成方案

### 3.1 主循环集成

```typescript
// src/core/mimo-loop.ts

export class MiMoLoop {
  private validator: CodeValidator;
  private completenessChecker: CompletenessChecker;
  private iterationManager: IterationManager;
  private contextManager: EnhancedContextManager;
  private repair: MiMoToolRepair;

  constructor(options: MiMoLoopOptions) {
    this.validator = new CodeValidator();
    this.completenessChecker = new CompletenessChecker();
    this.iterationManager = new IterationManager();
    this.contextManager = new EnhancedContextManager();
    this.repair = new MiMoToolRepair();
  }

  /**
   * 执行任务
   */
  async executeTask(task: string): Promise<TaskResult> {
    return this.iterationManager.executeWithRetry(
      task,
      {
        onBeforeExecute: async (context) => {
          // 优化上下文
          const optimized = await this.contextManager.optimizeForLongTask(
            context.messages,
            context.taskState,
            this.maxTokens
          );
          context.messages = optimized.messages;
        },

        onToolCall: async (toolCall) => {
          // 修复工具调用
          const repaired = await this.repair.repair(toolCall, this.context);
          return repaired.toolCall;
        },

        onToolResult: async (toolCall, result) => {
          // 验证工具结果
          const validation = await this.validator.validateToolResult(
            toolCall.function.name,
            JSON.parse(toolCall.function.arguments),
            result
          );

          if (!validation.passed) {
            // 返回验证失败信息，让模型修复
            return {
              content: `验证失败:\n${validation.suggestions.join('\n')}`,
              isError: true
            };
          }

          return result;
        },

        onComplete: async (result) => {
          // 检查完整性
          const completeness = await this.completenessChecker.checkCompleteness(
            task,
            result.content,
            this.context
          );

          if (!completeness.complete) {
            // 返回不完整信息，触发重试
            throw new IncompleteError(
              completeness.suggestions.join('\n')
            );
          }
        }
      }
    );
  }
}
```

### 3.2 配置选项

```json
// ~/.mimo/config.json
{
  "model": "mimo-v2.5-pro",
  "coding_optimizations": {
    "code_validation": {
      "enabled": true,
      "syntax_check": true,
      "type_check": true,
      "pattern_check": true
    },
    "completeness_check": {
      "enabled": true,
      "check_functions": true,
      "check_imports": true,
      "check_error_handling": true,
      "check_task_completion": true
    },
    "iteration": {
      "max_retries": 3,
      "learn_from_errors": true,
      "incremental_fix": true
    },
    "context": {
      "fold_threshold": 0.70,
      "aggressive_threshold": 0.75,
      "key_info_retention": 0.3,
      "smart_summary": true
    },
    "repair": {
      "json_repair": true,
      "type_repair": true,
      "value_repair": true,
      "path_repair": true
    }
  }
}
```

---

## 四、预期效果

### 4.1 量化目标

| 维度 | 当前MiMo | 优化后目标 | 提升幅度 |
|------|----------|------------|----------|
| EvoCode-Bench MT@4 | 17.3 | 25+ | +45% |
| RoadmapBench | 13.9% | 17%+ | +22% |
| Code Defect率 | 高 | 降低50% | -50% |
| 部分实现率 | 高 | 降低60% | -60% |

### 4.2 定性改进

1. **代码质量提升**
   - 减少语法错误
   - 减少类型错误
   - 减少逻辑错误

2. **完整性提升**
   - 函数实现更完整
   - 错误处理更完善
   - 测试覆盖更全面

3. **迭代效率提升**
   - 首次成功率提高
   - 修复速度加快
   - 上下文保持更好

4. **用户体验提升**
   - 更少的重试
   - 更快的完成
   - 更好的反馈

---

## 五、实施计划

### 5.1 第一阶段：基础优化（2周）

1. 实现CodeValidator
2. 实现CompletenessChecker
3. 集成到MiMoLoop

### 5.2 第二阶段：迭代优化（2周）

1. 实现IterationManager
2. 实现错误学习机制
3. 优化重试策略

### 5.3 第三阶段：上下文优化（2周）

1. 实现EnhancedContextManager
2. 优化关键信息保持
3. 实现智能摘要

### 5.4 第四阶段：修复优化（2周）

1. 实现MiMoToolRepair
2. 优化参数修复
3. 集成所有组件

---

**文档版本**: 3.0.0  
**最后更新**: 2026-05-27  
**基于**: DeepSeek V4 Pro vs MiMo V2.5 Pro 对比分析