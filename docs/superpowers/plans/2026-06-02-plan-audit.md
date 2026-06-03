# 2026-06-02 Superpowers 计划落盘审计与执行清单

## 审计范围

本审计覆盖以下 5 份计划：

- `docs/superpowers/plans/2026-06-02-integrated-learn-persona-superpowers.md`
- `docs/superpowers/plans/2026-06-02-wave1-tool-integration.md`
- `docs/superpowers/plans/2026-06-02-wave2a-reconcile-and-wire.md`
- `docs/superpowers/plans/2026-06-02-wave2b-shell-jobs.md`
- `docs/superpowers/plans/2026-06-02-wave2c-code-query.md`

审计方法：

1. 对照计划条目检查对应代码、目录、测试和工厂接线。
2. 区分“文件已存在”和“主流程已接线”。
3. 区分“主体已落盘”和“按计划完全收口”。
4. 当前仓库未安装本地 `typescript` / `vitest` 依赖，因此本次以静态审计为主，运行态验证状态单独注明。

## 总结结论

| 计划 | 结论 | 说明 |
|---|---|---|
| integrated-learn-persona-superpowers | 本轮已补齐静态缺口 | `/learn` 路由确认、router/frontmatter 对齐、pressure scenarios 测试已补入代码树 |
| wave1-tool-integration | 已落盘 | 目录、实现、barrel 导出、测试基本齐备 |
| wave2a-reconcile-and-wire | 已落盘 | ReadTracker 去重、rateLimit 配置接入、ChoiceTool 工厂接线都已进入主路径 |
| wave2b-shell-jobs | 已落盘 | shell/jobs 子系统、工厂注册、集成测试均已存在 |
| wave2c-code-query | 本轮已补齐静态缺口 | code-query 模块、依赖、构建脚本、工厂接线均已存在，且已补 `wave2c` 集成测试文件 |

## 执行 TODO 清单

- [x] 给 `/learn apply` 增加低置信度确认流，未确认时不写 persona 路由
- [x] 让 learned skill frontmatter 跟随 router 推导结果，而不是固定写死
- [x] 补 `tests/integration/wave2c-code-query.test.ts`
- [x] 将 `tests/integration/wave2a-rate-limit.test.ts` 中的 `echo` 样例替换为跨平台的 `node -e`
- [x] 补 integrated pressure scenarios 回归测试，覆盖低置信度路由和 learned skill 安全约束

## 逐项审计

### 1. `/learn` + Persona Skill Router + Minimum-native Superpowers

结论：本轮已补齐缺口，静态上可视为已落盘。

已落盘项：

| 计划阶段 | 现状 | 证据 |
|---|---|---|
| Phase 1 Minimum-native Superpowers | 已落盘 | `src/personas/inline-skills/minimum-adapted/` 已存在，含 planning、dispatch、review、testing、mission 子目录 |
| Phase 1 Master Planner 约束 | 已落盘 | `src/personas/prompts/master-planner.md` 已要求 write-capable task 具备 `allowedGlobs`、`acceptance`、`nonGoals`、`blockedCondition`，且 blocked task 不得原样重试 |
| Phase 2 `/learn` 命令闭环 | 已落盘 | `tui/src/commands.ts` 支持 `/learn --name`、`--dry-run`、`preview`、`apply`、`reject`、`status`；`tui/src/app.tsx` 已接 `learn.*` outcomes；`src/learn/` 服务层已存在 |
| Phase 3 learn-skill-writer | 已落盘 | `src/skills/system/learn-skill-writer/SKILL.md` 已存在；`LearnSkillPromptLoader`、`LearnedSkillWriter`、`LearnedSkillValidator` 已存在 |
| Phase 4 learned skill loader | 已落盘 | `src/skills/LearnedSkillLoader.ts` 已存在；`tui/src/commands.ts` 的 `/skill` 已合并 built-in 与 learned skills |
| Phase 5 Persona Skill Router | 已落盘 | `src/skills/system/persona-skill-router/SKILL.md`、`src/skills/PersonaSkillRouter.ts` 已存在；`/learn apply` 会写 `.minimum/skills/index.json` 与 `.minimum/skills/persona-skill-map.json` |
| Phase 6 runtime prompt 注入 | 已落盘 | `src/personas/SkillRegistry.ts`、`src/personas/PersonaSkillMap.ts`、`src/personas/PersonaRegistry.ts` 和 `src/orchestration/ClientAdapters.ts` 已形成注入链 |
| Phase 7 回归覆盖 | 已补齐 | `tests/unit/learn-service.test.ts`、`tests/unit/persona-skill-router.test.ts` 已存在，且新增 `tests/integration/integrated-learn-persona-superpowers.test.ts` 作为集中式 pressure scenarios 回归测试 |

本轮已执行 TODO：

- [x] `/learn apply --confirm-routing` 已加入命令解析、TUI 回显和服务层控制流
- [x] `LearnedSkillRenderer.ts` 已使用 router metadata 回填 `applies_to_personas`、`stage_affinity`、`routing`
- [x] `LearnedSkillWriter.ts` 支持在确认路由时复用已写入 skill，避免二次 apply 失败
- [x] `learn-service.test.ts` 已补低置信度确认与 frontmatter 对齐测试
- [x] `integrated-learn-persona-superpowers.test.ts` 已补 pressure scenarios

### 2. Wave 1 工具集成

结论：已落盘。

已落盘项：

| 计划任务 | 现状 | 证据 |
|---|---|---|
| Task 1 ToolRateLimiter | 已落盘 | `src/tools/limits/ToolRateLimiter.ts`、`tests/unit/ToolRateLimiter.test.ts` 已存在 |
| Task 2 ToolRegistry 接限流 | 已落盘 | `src/tools/ToolRegistry.ts` 支持可选 `rateLimiter` 并在派发前调用 `consume()` |
| Task 3 ReadTracker | 已落盘 | 最终已收敛为 canonical 版本 `src/loop/ReadTracker.ts`，符合后续 2a 的去重方向 |
| Task 4 ReadFileTool / EditFileTool 接 read guard | 已落盘 | `tests/unit/EditFileTool.test.ts`、`tests/unit/ReadTracker.test.ts` 已存在 |
| Task 5 TodoWriteTool 增强 | 已落盘 | `src/tools/todo/TodoWriteTool.ts` 与 `tests/unit/TodoWriteTool.test.ts` 已存在 |
| Task 6 ChoiceTool | 已落盘 | `src/tools/choice/ChoiceTool.ts`、`ConfirmationGate.ts`、`tests/unit/ChoiceTool.test.ts` 已存在 |
| Task 7 barrel 导出与 smoke | 已落盘 | `src/tools/index.ts` 已统一导出 Wave 1 相关符号 |

备注：

- Wave 1 的 `ReadTracker` 最终不是停在 `src/tools/state/`，而是被 Wave 2a 吸收到 `src/loop/ReadTracker.ts`。这属于“按后续计划继续演进”，不是缺失。

### 3. Wave 2a 收尾接线

结论：已落盘。

已落盘项：

| 计划任务 | 现状 | 证据 |
|---|---|---|
| Task 1 ReadTracker 去重 | 已落盘 | `src/tools/state/` 已不存在；`src/tools/index.ts` re-export 指向 `../loop/ReadTracker.js` |
| Task 2 rateLimit 接入 MiMoConfig + createMiMoStack | 已落盘 | `src/config/MiMoConfig.ts` 已有 `rateLimit?`；`src/config/createMiMoStack.ts` 会构造并返回 `rateLimiter` |
| Task 3 ChoiceTool 自动注册 | 已落盘 | `createMiMoStack.ts` 已注册 `ChoiceTool`，并接受 `confirmationGate` 注入 |
| Task 4 端到端限流验证 | 已落盘 | `tests/integration/wave2a-rate-limit.test.ts` 已存在 |

本轮已执行 TODO：

- [x] `wave2a-rate-limit.test.ts` 已将 `echo` 样例替换为 `node -e "console.log(...)"`，避免 Windows 下的 shell 内建命令差异

### 4. Wave 2b Shell + Jobs

结论：已落盘。

已落盘项：

| 计划任务 | 现状 | 证据 |
|---|---|---|
| Task 1 `parse.ts` | 已落盘 | `src/tools/shell/parse.ts`、`tests/unit/shell-parse.test.ts` 已存在 |
| Task 2 `shell-chain.ts` | 已落盘 | `src/tools/shell/shell-chain.ts`、`tests/unit/shell-chain.test.ts` 已存在 |
| Task 3 `exec.ts` | 已落盘 | `src/tools/shell/exec.ts`、`tests/unit/shell-exec.test.ts` 已存在 |
| Task 4 `JobRegistry` | 已落盘 | `src/tools/shell/JobRegistry.ts`、`tests/unit/JobRegistry.test.ts` 已存在 |
| Task 5 `ExecShellTool` 重写 | 已落盘 | `src/tools/shell/ExecShellTool.ts` 已不再依赖 `sh -c`，转为跨平台原生执行 |
| Task 6 5 个 Job 工具 | 已落盘 | `RunBackgroundTool.ts`、`JobOutputTool.ts`、`WaitForJobTool.ts`、`StopJobTool.ts`、`ListJobsTool.ts` 已存在 |
| Task 7 工厂注册 + 集成测试 | 已落盘 | `createMiMoStack.ts` 已注册相关工具；`tests/integration/wave2b-shell.test.ts` 已存在 |

补充说明：

- 该波的“主路径接线”已经完成，不是只有底层模块存在。
- `createMiMoStack()` 还会暴露共享 `jobs` 单例，符合计划要求。

### 5. Wave 2c Code Query

结论：本轮已补齐缺口，静态上可视为已落盘。

已落盘项：

| 计划任务 | 现状 | 证据 |
|---|---|---|
| Task 1 依赖 + grammar copy 脚本 | 已落盘 | `package.json` 已含 `web-tree-sitter` 与 6 个 grammar devDependency；`scripts/copy-grammars.mjs` 已存在；`build` 已接入 grammar copy |
| Task 2 `grammar-map.ts` + `parser.ts` | 已落盘 | `src/tools/code-query/grammar-map.ts`、`parser.ts` 已存在 |
| Task 3 `symbols.ts` | 已落盘 | `src/tools/code-query/symbols.ts` 与 `tests/fixtures/sample.ts`、`sample.py`、`tests/unit/code-symbols.test.ts` 已存在 |
| Task 4 `find-in-code.ts` | 已落盘 | `src/tools/code-query/find-in-code.ts` 与 `tests/unit/code-find-in-code.test.ts` 已存在 |
| Task 5 `SymbolsTool` / `CodeQueryTool` | 已落盘 | `src/tools/code-query/SymbolsTool.ts`、`CodeQueryTool.ts`、`index.ts` 已存在 |
| Task 6 工厂注册 | 已落盘 | `createMiMoStack.ts` 已注册 `get_symbols` 和 `find_in_code` |

本轮已执行 TODO：

- [x] 新增 `tests/integration/wave2c-code-query.test.ts`
- [x] 保留 `tests/unit/createMiMoStack.test.ts` 中原有的 builtins 注册覆盖，形成“单测 + 集成测试”双层收口

## 运行态验证状态

本轮已安装依赖并完成针对性验证：

- 通过：`npm test -- tests/unit/persona-skill-router.test.ts tests/unit/learn-command.test.ts tests/unit/learn-service.test.ts tests/integration/wave2a-rate-limit.test.ts tests/integration/wave2c-code-query.test.ts tests/integration/integrated-learn-persona-superpowers.test.ts`
- 未通过：`npm run typecheck`

因此当前结论应理解为：

- 本轮 TODO 对应功能与定向测试已经补齐。
- 全量类型检查仍被仓库中的既有问题阻塞，而不是本轮改动新增的问题。

## 当前备注

- 当前编辑器诊断为 0，说明本轮改动在静态层面没有新增明显问题。
- 当前 `typecheck` 阻塞点是 `src/commands/MemoryCommand.ts` 仍引用了未从 `../memory/governance/index.js` 导出的 `MemoryCommandService`。
