# `/learn` + Persona Skill Router + Minimum-native Superpowers 整合实现计划

## 摘要
本计划严格参照以下原始方案整合：

- `docs/persona_optimize_with_superpowers.md`
- `docs/learn_implemenat.md`
- `docs/PERSONA_SKILL_ASSIGN.md`
- `resource/learn-skill-writer.md`
- `resource/persona-skill-router.md`

核心原则：

```text
先接入 Minimum-native Superpowers 规则
再实现 /learn
再实现 learned skill loader
再实现 Persona Skill Router
最后把 routed skills 注入 persona runtime prompt
```

## Phase 1：Minimum-native Superpowers 先行接入
参照 `docs/persona_optimize_with_superpowers.md` 的 Superpowers 引入方式、推荐结构、adapted skill 拆解、Prompt 组装改造、master_planner 核心改造、W0/W0.5 输出变化、落地顺序和成功标准。

任务：
- 新增 `src/personas/inline-skills/minimum-adapted/`，包含 planning、dispatch、testing、review、mission 等 adapted skills。
- 新增 `_prompt-constraints.md`、`contract-first-planning.md`、`task-granularity.md`、`no-placeholder-plan.md`、`subagent-task-assignment.md`。
- 修改 `master-planner.md`，要求 write-capable task 必须有 `allowedGlobs`、`acceptance`、`nonGoals`、`blockedCondition`。
- blocked task 不允许原样重试，必须改变 context、owner 或 scope。

验收：
- `master_planner` 不再生成 “implement feature” 级粗任务。
- reviewer 先做 spec compliance，再做 code quality。
- W3.5 输出 `APPROVED_TO_W4`、`LOOP_BACK_TO_W1` 或 `NEEDS_HUMAN_CONFIRMATION`。

## Phase 2：`/learn` 命令闭环
参照 `docs/learn_implemenat.md` 的目标定义、推荐文件结构、命令设计、CommandOutcome 扩展、命令解析、LearnCommandService、TUI 接入和最小验收。

任务：
- 在 `tui/src/commands.ts` 增加 `/learn`、`/learn --name`、`/learn --dry-run`、`preview`、`apply`、`reject`、`status`。
- 新增 `src/learn/` 服务层：`LearnCommandService`、`LearnDraftStore`、`LearnSkillPromptLoader`、`LearnedSkillWriter`、`LearnedSkillValidator`、`LearnedSkillRenderer`、`LearnedSkillName`。
- 在 `tui/src/app.tsx` 接入 `learn.*` outcomes。

验收：
- `/learn --name pipeline-loop-check` 能生成 draft。
- `/learn preview <id>` 能预览。
- `/learn apply <id>` 能落盘 `SKILL.md` 与 `metadata.json`。
- `/learn status` 能列出 draft 和 learned skill 状态。

## Phase 3：接入 `learn-skill-writer` system skill
参照 `docs/learn_implemenat.md` 的 System Skill 注册、Prompt Loader、Skill Writer、推荐 Prompt，以及 `resource/learn-skill-writer.md` 的 Purpose、Input Contract、Output Contract、Hard Constraints、Quality Bar。

任务：
- 将 learn skill writer 落到 `src/skills/system/learn-skill-writer/SKILL.md`。
- `LearnSkillPromptLoader` 读取 system skill 并传入 conversation summary、recent messages、preferred name、project root 和 existing skill names。
- validator 校验 description 必须以 `Use when` 开头，body 必须包含 required sections，且不能含敏感信息。

## Phase 4：learned skill loader 接入 `/skill`
参照 `docs/learn_implemenat.md` 的 Learned Skill Loader、冲突策略、测试计划和最小可交付验收。

任务：
- 新增 `src/skills/LearnedSkillLoader.ts`。
- 扫描 `.minimum/skills/learned/<skill-name>/SKILL.md`。
- `/skill list`、`/skill info`、`/skill run` 合并 learned skills 与 built-in skills。
- 同名冲突默认不覆盖。

## Phase 5：Persona Skill Router
参照 `docs/PERSONA_SKILL_ASSIGN.md` 与 `resource/persona-skill-router.md` 的推荐流程、落盘结构、metadata schema、Persona Assignment Rules、Assignment Confidence、Runtime Loading Rule。

任务：
- 新增 `src/skills/system/persona-skill-router/SKILL.md`。
- 新增 `src/skills/PersonaSkillRouter.ts`。
- `/learn apply` 写 `.minimum/skills/index.json` 和 `.minimum/skills/persona-skill-map.json`。
- 低置信度不静默写入。

## Phase 6：persona runtime prompt 注入
参照 `docs/persona_optimize_with_superpowers.md` 的 Prompt 组装改造与 `docs/PERSONA_SKILL_ASSIGN.md` 的“分配给 persona，而不是全局加载”。

任务：
- 新增 `src/personas/SkillRegistry.ts` 与 `src/personas/PersonaSkillMap.ts`。
- `PersonaRegistry` 保持静态 roster，但 prompt 组装时注入 matched inline skills。
- 不允许 learned skill 修改 persona allowlist/path policy。

## Phase 7：pressure scenarios 与回归验证
参照 `docs/persona_optimize_with_superpowers.md` 的 pressure scenarios、`docs/learn_implemenat.md` 的测试计划，以及 `resource/persona-skill-router.md` 的 Validation Rules / Failure Modes。

任务：
- 覆盖 master 粗任务、review 顺序、test evidence、blocked repair、low confidence routing、learned skill 不修改 persona 等场景。

## 验证命令
```bash
npm run test
npm run typecheck
npm run build
```
