#!/usr/bin/env node

/**
 * MiMo Coding Optimizer CLI
 * 
 * Usage:
 *   minimum <task>           - Execute a coding task
 *   minimum --help           - Show help
 *   minimum --version        - Show version
 */

import { MiMoLoop, CodeValidator, ToolCallRepair, CompletenessChecker, ContextManager, IterationManager } from '../dist/index.js';

const args = process.argv.slice(2);

// 帮助信息
if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                   MiMo Coding Optimizer                       ║
║                   针对MiMo模型的编码体验优化                   ║
╚═══════════════════════════════════════════════════════════════╝

Usage:
  minimum <task>              执行编码任务
  minimum --help              显示帮助信息
  minimum --version           显示版本信息

Examples:
  minimum "实现一个快速排序算法"
  minimum "修复这段代码的bug"
  minimum "为这个函数添加单元测试"

Features:
  ✓ 代码验证 (CodeValidator)      - 语法、类型、模式检查
  ✓ 工具修复 (ToolCallRepair)     - JSON、类型、路径修复
  ✓ 完整性检查 (CompletenessChecker) - 函数、导入、错误处理检查
  ✓ 上下文管理 (ContextManager)   - 智能折叠、关键信息保持
  ✓ 迭代管理 (IterationManager)   - 自动重试、错误学习

Configuration:
  创建 minimum.config.json 配置文件来自定义行为

Documentation:
  查看 USAGE.md 获取详细使用说明
  `);
  process.exit(0);
}

// 版本信息
if (args.includes('--version') || args.includes('-v')) {
  console.log('minimum v1.0.0');
  process.exit(0);
}

// 获取任务描述
const task = args.filter(a => !a.startsWith('--')).join(' ');

if (!task) {
  console.error('Error: 请提供任务描述');
  console.log('Usage: minimum <task>');
  process.exit(1);
}

// 主执行函数
async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                   MiMo Coding Optimizer                       ║
╚═══════════════════════════════════════════════════════════════╝
`);

  console.log(`📋 Task: ${task}`);
  console.log(`📁 Working Directory: ${process.cwd()}`);
  console.log('─'.repeat(60));

  // 创建组件
  const validator = new CodeValidator({
    enabledCheckers: ['syntax', 'type', 'pattern']
  });

  const toolRepair = new ToolCallRepair();

  const completenessChecker = new CompletenessChecker();

  const contextManager = new ContextManager({
    foldThreshold: 0.70,
    aggressiveThreshold: 0.75,
    tailFraction: 0.25
  });

  const iterationManager = new IterationManager({
    maxRetries: 3,
    learnFromErrors: true
  });

  // 注意：这里需要提供真实的客户端和工具注册表
  // 目前使用示例占位符
  console.log(`
⚠️  Note: 需要配置模型客户端和工具注册表才能执行任务

配置方式:
1. 创建 minimum.config.json 文件
2. 或通过代码方式配置:

import { MiMoLoop, MiMoClient, ToolRegistry } from 'minimum';

const client = new MiMoClient({ apiKey: process.env.MIMO_API_KEY });
const tools = new ToolRegistry();

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

// 执行任务
for await (const event of loop.run('${task}')) {
  console.log(event);
}
`);

  // 显示配置的组件
  console.log('─'.repeat(60));
  console.log('✅ Configured Components:');
  console.log('  • CodeValidator - 代码验证器');
  console.log('  • ToolCallRepair - 工具调用修复器');
  console.log('  • CompletenessChecker - 完整性检查器');
  console.log('  • ContextManager - 上下文管理器');
  console.log('  • IterationManager - 迭代管理器');
  console.log('─'.repeat(60));

  // 导出配置供使用
  const config = {
    validator,
    toolRepair,
    completenessChecker,
    contextManager,
    iterationManager,
    workingDirectory: process.cwd()
  };

  console.log(`
💡 Quick Start:

import { MiMoLoop, MiMoClient, ToolRegistry } from 'minimum';

const config = ${JSON.stringify({
  validator: 'new CodeValidator()',
  toolRepair: 'new ToolCallRepair()',
  completenessChecker: 'new CompletenessChecker()',
  contextManager: 'new ContextManager({ foldThreshold: 0.70 })',
  iterationManager: 'new IterationManager({ maxRetries: 3 })'
}, null, 2)};

const loop = new MiMoLoop({
  client: yourClient,
  tools: yourTools,
  ...config,
  workingDirectory: '${process.cwd()}'
});
`);
}

main().catch(console.error);
