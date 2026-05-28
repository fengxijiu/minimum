# Minimum

Minimum 是一个基于 TypeScript 和 Ink 构建的终端 AI 编码助手，专为 MiMo 大语言模型设计。它提供了一个轻量级但功能完整的交互式 TUI（终端用户界面），让开发者可以在命令行中与 MiMo 模型进行对话、执行代码、管理文件，并通过智能工具调用完成复杂的编码任务。

## 项目定位

Minimum 的设计理念是"最小化但不简单"。相比完整的 IDE 插件或重量级 Agent 客户端，Minimum 专注于提供一个干净、高效的终端交互体验。它实现了一个完整的 MiMo Agent Loop（代理循环），能够：

- 接收自然语言指令并理解开发者意图
- 自主规划执行步骤并调用内置工具
- 读写文件、执行 Shell 命令、搜索代码
- 验证代码正确性并自动修复问题
- 管理会话上下文和执行历史

## 核心架构

项目采用模块化设计，主要由以下核心组件构成：

```
┌─────────────────────────────────────────────────────┐
│                    Ink TUI Layer                     │
│   (React-based terminal rendering, input handling)   │
├─────────────────────────────────────────────────────┤
│                   TuiController                      │
│      (Loop lifecycle, event normalization)           │
├──────────┬──────────┬──────────┬────────────────────┤
│ Session  │  Tools   │ MCP/ LSP │  Validators        │
│ Manager  │ Registry │ Clients  │ (Type/Syntax/Patt) │
├──────────┴──────────┴──────────┴────────────────────┤
│              MiMo API Client / Mock                  │
│         (Streaming chat completions)                 │
└─────────────────────────────────────────────────────┘
```

### 主要模块

| 模块 | 路径 | 说明 |
|------|------|------|
| **Loop Engine** | `src/loop/` | Agent 循环核心，驱动对话→工具调用→结果反馈的完整流程 |
| **TUI Layer** | `src/index/` | 基于 Ink/React 的终端渲染层，负责界面展示和用户交互 |
| **Tools** | `src/tools/` | 内置工具集，包括文件系统、Git、Shell、搜索、Web 等操作 |
| **Validators** | `src/validators/` | 代码验证器，支持 TypeScript 类型检查、语法检查、模式匹配 |
| **Session** | `src/session/` | 会话管理，支持保存/加载对话历史和检查点 |
| **MCP** | `src/mcp/` | Model Context Protocol 客户端，支持扩展工具能力 |
| **LSP** | `src/lsp/` | Language Server Protocol 集成，提供语言智能支持 |
| **Approval** | `src/approval/` | 权限审批系统，控制敏感操作的执行授权 |
| **Capacity** | `src/capacity/` | 容量控制器，管理 token 使用和上下文窗口 |
| **Telemetry** | `src/telemetry/` | 遥测系统，收集使用数据和性能指标 |
| **Subagent** | `src/subagent/` | 子代理系统，支持任务分解和并行执行 |
| **Skills** | `src/skills/` | 技能注册系统，可扩展 Agent 能力 |
| **Memory** | `src/memory/` | 记忆系统，维护跨会话的上下文信息 |
| **Repair** | `src/repair/` | 代码修复模块，自动检测和修复常见问题 |

## 功能特性

### 交互体验

- **流式输出**: 实时显示 AI 回复，无需等待完整响应
- **卡片式界面**: 助手回复、工具调用、工具结果分别以独立卡片展示
- **任务队列**: 支持批量提交任务，自动排队执行
- **即时取消**: 使用 `Esc` 或 `/cancel` 随时中断当前操作
- **中途引导**: 通过 `/steer` 在执行过程中注入额外指令
- **文件引用**: 使用 `@path` 语法快速引用文件路径
- **命令补全**: `Tab` 键触发命令和文件路径自动补全

### 内置工具

| 工具类别 | 功能 |
|---------|------|
| **文件系统** | 读取、写入、编辑文件；创建目录；列出文件 |
| **Git** | 查看状态、差异、日志；提交；分支管理 |
| **Shell** | 执行系统命令（默认禁用，需手动开启） |
| **搜索** | 全文搜索、正则匹配、文件查找 |
| **Web** | 网页抓取、内容提取 |
| **Todo** | 任务列表管理 |

### 会话管理

- **自动保存**: 对话历史自动持久化到 `.minimum/sessions/`
- **检查点**: 关键节点自动创建检查点，支持回溯
- **导出/导入**: JSON 格式的完整对话记录

### 安全控制

- **权限审批**: 敏感操作（如 Shell 执行）需要用户明确授权
- **Mock 模式**: 未配置 API Key 时自动使用本地模拟模式
- **容量限制**: Token 使用量监控和上下文窗口管理

## 快速开始

### 环境要求

- Node.js 22 或更新版本
- npm 包管理器

### 安装

```bash
# 克隆项目
git clone https://github.com/your-org/minimum.git
cd minimum

# 安装依赖
npm install

# 构建项目
npm run build
```

### 运行

```bash
# 方式一：直接运行构建产物
node bin/minimum-ink.js

# 方式二：使用 npx（推荐）
npx minimum

# 方式三：开发模式（热重载）
npm run dev
```

### 配置 MiMo API

默认情况下，Minimum 使用本地 Mock 模式。要使用真实的 MiMo API：

```bash
# 设置 API Key
export MIMO_API_KEY=your_api_key_here

# 可选：自定义 API 端点
export MIMO_BASE_URL=https://api.xiaomimimo.com/v1

# 可选：启用 Shell 工具执行（默认禁用）
export MINIMUM_ENABLE_SHELL=1
```

## 使用指南

### 基本对话

启动 Minimum 后，直接在输入框中输入自然语言指令即可开始对话：

```
> 帮我创建一个 Python Flask 应用，包含用户登录功能
```

### 文件引用

使用 `@` 符号引用项目中的文件：

```
> 分析 @src/main.ts 中的代码，找出潜在的性能问题
```

### TUI 命令

```text
/help          显示所有可用命令
/new           开始新的会话
/save [name]   保存当前对话到 .minimum/sessions/
/load [name]   加载历史对话
/sessions      列出所有已保存的会话
/status        显示运行时状态
/queue         显示任务队列
/queue         清空任务队列
/steer <text>  在当前执行中注入额外指令
/cancel        取消当前执行
/loop 30s task 循环执行指定任务
/loop          停止循环任务
/clear         清空屏幕显示
/exit          退出程序
```

### 示例工作流

```
> /new
> 创建一个 Express.js REST API 项目，包含用户 CRUD 操作
  [Minimum 自动创建项目结构、安装依赖、编写代码...]

> @src/routes/users.ts 添加输入验证
  [Minimum 分析现有代码并添加验证逻辑...]

> /steer 使用 Joi 库进行验证
  [中途调整方向，指定使用特定库...]

> 运行测试确保所有接口正常工作
  [Minimum 执行测试并报告结果...]
```

## 开发指南

### 项目结构

```
minimum/
├── src/
│   ├── index/          # TUI 入口和主界面组件
│   ├── loop/           # Agent 循环引擎
│   ├── tools/          # 内置工具实现
│   │   ├── filesystem/ # 文件系统操作
│   │   ├── git/        # Git 命令封装
│   │   ├── shell/      # Shell 命令执行
│   │   ├── search/     # 代码搜索
│   │   └── web/        # 网页抓取
│   ├── validators/     # 代码验证器
│   ├── session/        # 会话管理
│   ├── mcp/            # MCP 协议客户端
│   ├── lsp/            # LSP 协议集成
│   ├── approval/       # 权限审批
│   ├── capacity/       # 容量控制
│   ├── telemetry/      # 遥测数据
│   ├── subagent/       # 子代理系统
│   ├── skills/         # 技能注册
│   ├── memory/         # 记忆系统
│   ├── repair/         # 代码修复
│   ├── config/         # 配置管理
│   ├── context/        # 上下文管理
│   ├── hooks/          # 生命周期钩子
│   ├── bridge/         # 桥接层
│   ├── clients/        # API 客户端
│   ├── commands/       # 命令处理
│   ├── completeness/   # 完整性检查
│   ├── iteration/      # 迭代控制
│   ├── transcript/     # 转录处理
│   ├── tasks/          # 任务管理
│   ├── mocks/          # Mock 实现
│   ├── types/          # TypeScript 类型定义
│   └── utils/          # 工具函数
├── tests/              # 测试文件
├── bin/                # 可执行入口
└── dist/               # 构建输出
```

### 开发命令

```bash
# 运行测试
npm test

# 监听模式运行测试
npm run test:watch

# 生成测试覆盖率报告
npm run test:coverage

# 代码检查
npm run lint

# 自动修复代码风格
npm run lint:fix

# 格式化代码
npm run format

# 类型检查
npm run typecheck
```

### 添加新工具

1. 在 `src/tools/` 下创建新的工具目录
2. 实现工具接口，定义名称、描述、参数和执行逻辑
3. 在工具注册中心注册新工具
4. 编写单元测试验证功能

### 添加新技能

1. 在 `src/skills/` 下创建技能定义文件
2. 实现技能触发条件和执行逻辑
3. 在技能注册中心注册

## 配置选项

### 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `MIMO_API_KEY` | MiMo API 认证密钥 | 未设置（Mock 模式） |
| `MIMO_BASE_URL` | API 端点地址 | `https://api.xiaomimimo.com/v1` |
| `MINIMUM_ENABLE_SHELL` | 启用 Shell 工具执行 | `0`（禁用） |
| `MINIMUM_TELEMETRY` | 启用遥测数据收集 | `1`（启用） |

### 配置文件

项目配置存储在 `.minimum/` 目录下：

- `sessions/` - 会话历史记录
- `checkpoints/` - 检查点数据
- `config.json` - 运行时配置

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request。请确保：

1. 代码通过所有测试 (`npm test`)
2. 符合项目代码风格 (`npm run lint`)
3. TypeScript 类型检查通过 (`npm run typecheck`)
4. 新功能包含相应的测试用例
