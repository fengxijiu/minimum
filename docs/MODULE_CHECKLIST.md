# MiMo 模块验证与完善清单

> 项目: minimum v2.0.0 | 技术栈: TypeScript + React (Ink TUI) + Vitest
> 更新时间: 2026-05-28

---

## 一、核心引擎层

- [x] **types** `src/types/` — 全局类型定义 (6 files)
- [x] **utils** `src/utils/` — 工具函数 (5 files) ✅ 17 个导出函数全覆盖 (76 tests)
- [x] **config** `src/config/` — 配置加载与合并 (3 files)
- [x] **loop** `src/loop/` — 主事件循环 (6 files)

## 二、验证与修复层

- [x] **validators** `src/validators/` — 代码验证器 (5 files)
- [x] **repair** `src/repair/` — 工具调用修复 (6 files)
- [x] **completeness** `src/completeness/` — 完整性检查 (5 files)
- [x] **iteration** `src/iteration/` — 迭代管理 (4 files)

## 三、上下文与内存层

- [x] **context** `src/context/` — 上下文管理 (4 files)
- [x] **memory** `src/memory/` — 内存系统 (4 files)
- [x] **index** `src/index/` — 语义索引 (4 files) ✅ 25 tests

## 四、工具层

- [x] **tools/filesystem** `src/tools/filesystem/` — 文件操作 (7 files) ✅ 已验证可用
- [x] **tools/git** `src/tools/git/` — Git 操作 (1 file) ✅ 已验证可用，已清理死代码
- [x] **tools/shell** `src/tools/shell/` — Shell 执行 (2 files) ✅ 已验证可用
- [x] **tools/search** `src/tools/search/` — 代码搜索 (2 files) ✅ 已验证可用，已修复命令注入
- [x] **tools/web** `src/tools/web/` — Web 抓取 (2 files) ✅ 已验证可用，安全拦截正常
- [x] **tools/todo** `src/tools/todo/` — 待办管理 (2 files) ✅ 已验证可用，已注册到 Ink TUI
- [x] **ToolRegistry** `src/tools/ToolRegistry.ts` — 工具注册中心 ✅ 已验证可用

## 五、会话与命令层

- [x] **commands** `src/commands/` — 命令系统 (12 files)
- [x] **session** `src/session/` — 会话管理 (3 files)
- [x] **transcript** `src/transcript/` — 对话记录 (3 files)

## 六、扩展与集成层

- [x] **hooks** `src/hooks/` — 钩子系统 (3 files) ✅ 20 tests
- [x] **approval** `src/approval/` — 审批系统 (3 files) ✅ 36 tests
- [x] **skills** `src/skills/` — 技能系统 (4 files) ✅ 24 tests
- [x] **mcp** `src/mcp/` — MCP 协议支持 (3 files)
- [x] **subagent** `src/subagent/` — 子代理系统 (3 files) ✅ 22 tests
- [x] **tasks** `src/tasks/` — 任务队列 (3 files)
- [x] **capacity** `src/capacity/` — 容量控制 (3 files) ✅ 19 tests
- [x] **telemetry** `src/telemetry/` — 遥测统计 (3 files) ✅ 24 tests

## 七、UI 层

- [x] **tui (Ink)** `tui/src/` — Ink TUI 应用 (~20 files) ✅ 唯一 TUI 实现
- [x] **bridge** `src/bridge/` — 引擎-TUI 桥接 (2 files) ✅ 44 tests

## 八、测试基础设施

- [x] **mocks** `src/mocks/` — Mock 对象 (7 files)
- [x] **tests/unit** — 单元测试 (14 files, 239 tests pass)
- [x] **tests/integration** — 集成测试 (6 files)

---

## 完善动作清单

### P0 — 代码质量检查

- [x] 运行 `biome check` — 安全自动修复已应用 (37 src + 26 tests 文件)，剩余 279 个 lint 错误 (226 noExplicitAny + 53 其他)
- [x] 确认 `dist/` 与 `src/` 同步 — 28 个子目录完全一致
- [x] 验证 `src/index.ts` 导出完整性 — 所有模块已正确 re-export
- [x] TypeScript 编译 (`tsc --noEmit`) — 零错误
- [x] 全量测试 (`vitest run`) — 239/239 通过

### P0.5 — 工具模块审查

- [x] 删除 Legacy TUI (`src/tui/`, `bin/minimum-tui.js`)
- [x] 修复 GrepTool/SearchTool 命令注入 — 改用 `execFile` + 参数数组，绕过 shell
- [x] 修复 GlobTool 正则转义 — 补全 `.+^${}()|[]\` 转义
- [x] 注册 TodoWriteTool 到 Ink TUI 引擎
- [x] 清理死代码 (GitStatusTool/GitDiffTool/GitLogTool)
- [x] 逐工具可用性验证 — 24/24 通过 (ReadFile/WriteFile/EditFile/ApplyPatch/Glob/ListDir/Grep/Search/Git/ExecShell/WebFetch/TodoWrite/ToolRegistry)

### P1 — 补充缺失测试 (核心路径)

- [x] `src/utils/` — json-repair, path-utils, token-counter, similarity, syntax-checker ✅ 76 tests
- [x] `src/index/` — SemanticIndex, Chunker, EmbeddingProvider ✅ 25 tests
- [x] `src/hooks/` — HookManager ✅ 20 tests
- [x] `src/capacity/` — CapacityController ✅ 19 tests
- [x] `src/bridge/` — EngineBridge ✅ 44 tests

### P2 — 补充缺失测试 (扩展模块)

- [x] `src/skills/` — SkillRegistry, SkillLoader, BuiltinSkills ✅ 24 tests
- [x] `src/subagent/` — SubAgent, SubAgentManager ✅ 22 tests
- [x] `src/telemetry/` — TelemetryManager ✅ 24 tests
- [x] `src/approval/` — ApprovalManager (独立覆盖) ✅ 36 tests
