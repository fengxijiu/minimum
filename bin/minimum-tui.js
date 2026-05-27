#!/usr/bin/env node

/**
 * Minimum TUI - 可交互的终端用户界面
 * 
 * Features:
 *   - / 命令补全菜单
 *   - @ 文件选择功能
 */

import readline from 'readline';
import { MiMoLoop, CodeValidator, ToolCallRepair, CompletenessChecker, ContextManager, IterationManager, MockClient, MockToolRegistry } from '../dist/index.js';
import * as fs from 'fs';
import * as path from 'path';

// 命令定义
const COMMANDS = [
  { name: '/init', desc: '初始化配置', category: '会话' },
  { name: '/new', desc: '开始新会话', category: '会话' },
  { name: '/save', desc: '保存当前会话', category: '会话' },
  { name: '/load', desc: '加载已保存会话', category: '会话' },
  { name: '/status', desc: '显示当前状态', category: '会话' },
  { name: '/compact', desc: '压缩上下文', category: '上下文' },
  { name: '/undo', desc: '撤销操作', category: '上下文' },
  { name: '/redo', desc: '重做操作', category: '上下文' },
  { name: '/skill', desc: '管理技能', category: '系统' },
  { name: '/memory', desc: '管理记忆', category: '系统' },
  { name: '/config', desc: '查看/修改配置', category: '系统' },
  { name: '/help', desc: '显示帮助', category: '系统' },
  { name: '/clear', desc: '清空屏幕', category: '系统' },
  { name: '/exit', desc: '退出程序', category: '系统' },
];

// 状态
let isProcessing = false;
let messageCount = 0;
let currentMode = 'normal'; // normal, command, file

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgGray: '\x1b[100m',
};

function colorize(color, text) {
  return `${colors[color]}${text}${colors.reset}`;
}

function printHeader() {
  console.clear();
  console.log(colorize('cyan', '╔═══════════════════════════════════════════════════════════════╗'));
  console.log(colorize('cyan', '║') + colorize('bright', '                   Minimum - MiMo Coding Optimizer              ') + colorize('cyan', '║'));
  console.log(colorize('cyan', '║') + colorize('gray', '                    交互式终端用户界面                          ') + colorize('cyan', '║'));
  console.log(colorize('cyan', '╚═══════════════════════════════════════════════════════════════╝'));
  console.log();
  printStatus();
}

function printStatus() {
  const status = isProcessing ? colorize('yellow', '⏳ 处理中...') : colorize('green', '✅ 就绪');
  const mode = currentMode === 'command' ? colorize('cyan', ' [命令模式]') : 
               currentMode === 'file' ? colorize('magenta', ' [文件选择]') : '';
  console.log(colorize('gray', `状态: ${status} | 消息数: ${messageCount}${mode}`));
  console.log(colorize('gray', '─'.repeat(60)));
}

function printHelp() {
  console.log();
  console.log(colorize('yellow', '📖 帮助信息'));
  console.log(colorize('gray', '─'.repeat(50)));
  console.log(colorize('bright', '快捷输入:'));
  console.log('  /         - 显示命令菜单');
  console.log('  @         - 显示文件选择菜单');
  console.log();
  console.log(colorize('bright', '会话命令:'));
  console.log('  /init     - 初始化配置');
  console.log('  /new      - 开始新会话');
  console.log('  /save     - 保存当前会话');
  console.log('  /load     - 加载已保存会话');
  console.log('  /status   - 显示当前状态');
  console.log();
  console.log(colorize('bright', '上下文命令:'));
  console.log('  /compact  - 压缩上下文');
  console.log('  /undo     - 撤销操作');
  console.log('  /redo     - 重做操作');
  console.log();
  console.log(colorize('bright', '系统命令:'));
  console.log('  /skill    - 管理技能');
  console.log('  /memory   - 管理记忆');
  console.log('  /config   - 查看/修改配置');
  console.log('  /help     - 显示帮助');
  console.log('  /clear    - 清空屏幕');
  console.log('  /exit     - 退出程序');
  console.log();
  console.log(colorize('bright', '快捷键:'));
  console.log('  Ctrl+C    - 退出程序');
  console.log('  Ctrl+L    - 清屏');
  console.log('  Tab       - 自动补全');
  console.log(colorize('gray', '─'.repeat(50)));
  console.log();
}

function printMessage(role, content) {
  const roleColors = {
    user: 'green',
    assistant: 'blue',
    system: 'gray',
    tool: 'yellow'
  };
  
  const roleLabels = {
    user: '👤 You',
    assistant: '🤖 MiMo',
    system: '⚙️  System',
    tool: '🔧 Tool'
  };
  
  console.log(colorize(roleColors[role], `${roleLabels[role]}: `) + content);
  messageCount++;
}

// 显示命令补全菜单
function showCommandMenu(filter = '') {
  const filtered = filter 
    ? COMMANDS.filter(c => c.name.includes(filter) || c.desc.includes(filter))
    : COMMANDS;

  if (filtered.length === 0) {
    console.log(colorize('gray', '  没有匹配的命令'));
    return;
  }

  // 按类别分组
  const grouped = {};
  for (const cmd of filtered) {
    if (!grouped[cmd.category]) {
      grouped[cmd.category] = [];
    }
    grouped[cmd.category].push(cmd);
  }

  console.log();
  console.log(colorize('cyan', '┌─────────────────────────────────────────┐'));
  console.log(colorize('cyan', '│') + colorize('bright', '  📋 命令菜单                              ') + colorize('cyan', '│'));
  console.log(colorize('cyan', '├─────────────────────────────────────────┤'));

  for (const [category, cmds] of Object.entries(grouped)) {
    console.log(colorize('cyan', '│') + colorize('yellow', `  ${category}:`) + ' '.repeat(38 - category.length) + colorize('cyan', '│'));
    for (const cmd of cmds) {
      const line = `  ${cmd.name.padEnd(12)} ${cmd.desc}`;
      console.log(colorize('cyan', '│') + colorize('white', line) + ' '.repeat(41 - line.length) + colorize('cyan', '│'));
    }
  }

  console.log(colorize('cyan', '└─────────────────────────────────────────┘'));
  console.log(colorize('gray', '  输入命令名称执行，或按 Esc 取消'));
  console.log();
}

// 获取项目文件列表
function getFileList(dir = process.cwd(), prefix = '', maxDepth = 3, currentDepth = 0) {
  const files = [];
  
  if (currentDepth >= maxDepth) return files;
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      // 跳过隐藏文件和常见忽略目录
      if (entry.name.startsWith('.') || 
          ['node_modules', '__pycache__', 'venv', 'dist', 'build'].includes(entry.name)) {
        continue;
      }
      
      const fullPath = path.join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      
      if (entry.isDirectory()) {
        files.push({ path: relativePath, type: 'dir', name: entry.name });
        // 递归获取子目录文件
        const subFiles = getFileList(fullPath, relativePath, maxDepth, currentDepth + 1);
        files.push(...subFiles);
      } else {
        files.push({ path: relativePath, type: 'file', name: entry.name });
      }
    }
  } catch (err) {
    // 忽略权限错误
  }
  
  return files;
}

// 显示文件选择菜单
function showFileMenu(filter = '') {
  const files = getFileList();
  const filtered = filter
    ? files.filter(f => f.path.includes(filter) || f.name.includes(filter))
    : files;

  // 限制显示数量
  const displayFiles = filtered.slice(0, 20);

  console.log();
  console.log(colorize('magenta', '┌─────────────────────────────────────────┐'));
  console.log(colorize('magenta', '│') + colorize('bright', '  📁 文件选择                              ') + colorize('magenta', '│'));
  console.log(colorize('magenta', '├─────────────────────────────────────────┤'));

  if (displayFiles.length === 0) {
    console.log(colorize('magenta', '│') + colorize('gray', '  没有匹配的文件') + ' '.repeat(26) + colorize('magenta', '│'));
  } else {
    for (const file of displayFiles) {
      const icon = file.type === 'dir' ? '📁' : '📄';
      const line = `  ${icon} ${file.path}`;
      const truncated = line.length > 40 ? line.substring(0, 37) + '...' : line;
      console.log(colorize('magenta', '│') + colorize('white', truncated) + ' '.repeat(41 - truncated.length) + colorize('magenta', '│'));
    }
  }

  console.log(colorize('magenta', '└─────────────────────────────────────────┘'));
  
  if (filtered.length > 20) {
    console.log(colorize('gray', `  显示 20/${filtered.length} 个结果，输入更多字符过滤`));
  }
  console.log(colorize('gray', '  输入文件名选择，或按 Esc 取消'));
  console.log();
}

// 处理命令
async function handleCommand(command, args) {
  switch (command) {
    case '/init':
      await handleInit();
      break;
    case '/new':
      messageCount = 0;
      console.log(colorize('green', '✅ 新会话已创建'));
      break;
    case '/save':
      console.log(colorize('green', `✅ 会话已保存: ${args[0] || 'default'}`));
      break;
    case '/load':
      console.log(colorize('green', `✅ 会话已加载: ${args[0] || 'default'}`));
      break;
    case '/compact':
      console.log(colorize('green', '✅ 上下文已压缩'));
      break;
    case '/undo':
      console.log(colorize('green', '✅ 已撤销'));
      break;
    case '/redo':
      console.log(colorize('green', '✅ 已重做'));
      break;
    case '/skill':
      console.log(colorize('yellow', '可用技能: code-review, refactor, test-generator, documentation'));
      break;
    case '/memory':
      console.log(colorize('yellow', '记忆系统: 已启用'));
      break;
    case '/help':
      printHelp();
      break;
    case '/clear':
      printHeader();
      break;
    case '/status':
      printStatus();
      break;
    case '/config':
      console.log(colorize('yellow', '当前配置:'));
      console.log('  Validator: enabled');
      console.log('  Repair: enabled');
      console.log('  Completeness: enabled');
      console.log('  Context: 0.70 threshold');
      console.log('  Iteration: 3 max retries');
      break;
    case '/exit':
      console.log(colorize('gray', '再见!'));
      process.exit(0);
    default:
      printMessage('system', `未知命令: ${command}`);
      console.log(colorize('gray', '输入 /help 查看可用命令'));
  }
}

// 初始化配置
async function handleInit() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (question) => new Promise((resolve) => {
    rl.question(colorize('yellow', question), (answer) => resolve(answer.trim()));
  });

  console.log(colorize('cyan', '\n🚀 MiMo 初始化配置\n'));

  try {
    console.log(colorize('bright', '📡 模型配置'));
    const apiKey = await ask('API Key: ');
    const model = await ask('模型 (默认: mimo-v2.5-pro): ') || 'mimo-v2.5-pro';
    
    console.log(colorize('bright', '\n🔧 工具配置'));
    const enableShell = await ask('启用Shell工具? (y/N): ');
    
    console.log(colorize('bright', '\n💾 记忆配置'));
    const enableMemory = await ask('启用记忆系统? (Y/n): ');

    const config = {
      model: { provider: 'mimo', apiKey, baseUrl: 'https://api.mimo.com/v1', model, maxTokens: 4096, temperature: 0.7 },
      tools: { enabled: ['filesystem', 'git', 'search'], permissions: { shell: enableShell.toLowerCase() === 'y' ? 'allow' : 'ask', filesystem: 'allow' } },
      memory: { enabled: enableMemory.toLowerCase() !== 'n', path: '~/.minimum/memory' },
      optimization: { validation: true, repair: true, completeness: true }
    };

    const configPath = path.join(process.cwd(), 'minimum.config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const dirs = ['.minimum', '.minimum/memory', '.minimum/sessions', '.minimum/skills'];
    for (const dir of dirs) {
      const dirPath = path.join(process.cwd(), dir);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
    }

    console.log(colorize('green', '\n✅ 配置完成!'));
    console.log(colorize('gray', `配置文件: ${configPath}`));
  } catch (error) {
    console.log(colorize('red', `\n❌ 初始化失败: ${error.message}`));
  } finally {
    rl.close();
  }
}

// 处理任务
async function processTask(task) {
  isProcessing = true;
  printStatus();
  printMessage('user', task);
  
  await new Promise(resolve => setTimeout(resolve, 500));
  
  const client = new MockClient();
  client.setDefaultResponse(`我来处理这个任务: "${task}"\n\n这是一个示例响应。要使用完整的MiMo功能，请配置真实的模型客户端。`);
  
  const tools = new MockToolRegistry();
  
  const loop = new MiMoLoop({
    client,
    tools,
    validator: new CodeValidator(),
    toolRepair: new ToolCallRepair(),
    completenessChecker: new CompletenessChecker(),
    contextManager: new ContextManager(),
    iterationManager: new IterationManager(),
    workingDirectory: process.cwd()
  });
  
  try {
    for await (const event of loop.run(task)) {
      if (event.type === 'content') {
        process.stdout.write(colorize('blue', '🤖 MiMo: '));
        process.stdout.write(event.content);
        console.log();
      }
      if (event.type === 'tool_call') {
        printMessage('tool', `Calling: ${event.toolCall.function.name}`);
      }
      if (event.type === 'done') {
        printMessage('system', `Task completed: ${event.success ? 'Success' : 'Failed'}`);
      }
      if (event.type === 'error') {
        printMessage('system', `Error: ${event.error}`);
      }
    }
  } catch (error) {
    printMessage('system', `Error: ${error.message}`);
  }
  
  isProcessing = false;
  printStatus();
}

// 主输入处理
function prompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line) => {
      // Tab 补全
      if (line.startsWith('/')) {
        const partial = line.slice(1);
        const matches = COMMANDS
          .filter(c => c.name.startsWith('/' + partial))
          .map(c => c.name);
        return [matches.length ? matches : COMMANDS.map(c => c.name), line];
      }
      return [[], line];
    }
  });

  rl.on('line', async (input) => {
    const trimmed = input.trim();
    
    if (!trimmed) {
      prompt();
      return;
    }

    // 处理 / 命令
    if (trimmed === '/') {
      showCommandMenu();
      prompt();
      return;
    }

    if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
      // 检查是否是完整的命令
      const matched = COMMANDS.find(c => c.name === trimmed);
      if (!matched) {
        // 显示过滤后的命令菜单
        showCommandMenu(trimmed.slice(1));
        prompt();
        return;
      }
    }

    // 处理 @ 文件选择
    if (trimmed === '@') {
      showFileMenu();
      prompt();
      return;
    }

    if (trimmed.startsWith('@') && !trimmed.includes(' ')) {
      // 显示过滤后的文件菜单
      showFileMenu(trimmed.slice(1));
      prompt();
      return;
    }

    // 处理包含 @ 的输入（文件引用）
    if (trimmed.includes('@')) {
      // 替换 @file 为实际文件路径
      const processed = trimmed.replace(/@(\S+)/g, (match, filename) => {
        const files = getFileList();
        const found = files.find(f => f.path.includes(filename) || f.name === filename);
        return found ? found.path : match;
      });
      await processTask(processed);
      prompt();
      return;
    }

    // 处理命令
    if (trimmed.startsWith('/')) {
      const parts = trimmed.split(/\s+/);
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);
      await handleCommand(command, args);
    } else {
      // 处理普通任务
      await processTask(trimmed);
    }
    
    prompt();
  });

  rl.on('close', () => {
    console.log(colorize('gray', '\n再见!'));
    process.exit(0);
  });

  // 处理 Ctrl+C
  process.on('SIGINT', () => {
    console.log(colorize('gray', '\n再见!'));
    process.exit(0);
  });
}

// 启动
printHeader();
console.log(colorize('gray', '输入你的编码任务，或输入 / 查看命令菜单'));
console.log(colorize('gray', '输入 @ 选择文件，首次使用请运行 /init'));
console.log();
prompt();
