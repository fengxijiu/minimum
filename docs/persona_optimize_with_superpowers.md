# 完整引入方案：Minimum-native Superpowers Skills + Master Planner Dispatch 强化

目标：**不改变 `minimum` 的 W0–W4 / W3.5 主流水线，不优先新增 persona，而是把 Superpowers 的大 skill 拆成适配 `minimum` 的小型 inline skills，并把 `subagent-driven-development` 的调度思想直接融合进 `master_planner` 的任务分配规则。**

当前 `minimum` 的 `PersonaRegistry` 是静态 roster，注释明确表示新增 role 需要代码变更以审查 tool allowlist 和 path policy；同时现有 prompt 组装主要是 `role-specific text + _common-footer.md`。因此这次引入的主线应该是 **skill 层和 prompt 层改造**，而不是大幅扩展 persona 数量。

---

# 1. 总体架构

## 1.1 现有流水线保持不变

继续保留：

```text
W0      master_planner 编译 coarse DAG
W1      vision / repo_scout / context_builder 感知
W0.5    master_planner refine TaskContract
W2/W3   worker 执行、测试、调试、审查、文档
W3.5    MissionChecker 回环验收
W4      finalize + merge plan + memory governance
```

`master_planner` 当前已经承担 DAG 编译、persona 分配、TaskContract 约束、冲突检测、refine、W4 finalize 等职责。 这次更新是把它强化成：

```text
Task Compiler
+ Dispatch Planner
+ Context Isolation Controller
+ Review Gate Planner
+ Repair Router
```

---

# 2. Superpowers 的引入方式

## 2.1 不原样注入 Superpowers

不要直接把这些文件整段塞进 prompt：

```text
superpowers/subagent-driven-development/SKILL.md
superpowers/writing-plans/SKILL.md
superpowers/test-driven-development/SKILL.md
superpowers/requesting-code-review/SKILL.md
```

原因：

| 原始 Superpowers 假设                         | 在 `minimum` 中的问题                                |
| ----------------------------------------- | ----------------------------------------------- |
| fresh subagent per task                   | `minimum` 是固定 persona + TaskContract            |
| implementer commits                       | `minimum` 是 patch report + W4 merge plan        |
| human approval checkpoints                | `minimum` 是自动流水线，只有阻塞时 NEEDS_HUMAN_CONFIRMATION |
| plan file                                 | `minimum` 的计划实体是 W0 DAG / W0.5 TaskContract     |
| spec reviewer / code reviewer 独立 subagent | `minimum` 目前可以先映射为 reviewer 内部 two-pass review  |

Superpowers 的 `subagent-driven-development` 核心是 fresh subagent per task、隔离上下文、精确构造任务输入、spec review 先于 code quality review、blocked 时不要原样重试。([GitHub][1]) 这些应该被改写为 `minimum` 的 **TaskContract dispatch policy**。

---

## 2.2 推荐结构

```text
src/personas/
  inline-skills/
    upstream-superpowers/
      subagent-driven-development/SKILL.md
      writing-plans/SKILL.md
      test-driven-development/SKILL.md
      requesting-code-review/SKILL.md
      finishing-a-development-branch/SKILL.md
      writing-skills/SKILL.md

    minimum-adapted/
      planning/
        contract-first-planning.md
        task-granularity.md
        no-placeholder-plan.md

      dispatch/
        subagent-task-assignment.md
        context-isolated-dispatch.md
        worker-status-protocol.md
        blocked-escalation.md

      testing/
        test-impact-selection.md
        red-test-contract.md
        green-verification.md
        test-quality-review.md
        test-exception-policy.md

      review/
        spec-compliance-review.md
        code-quality-review.md
        review-severity-policy.md

      mission/
        mission-repair-gate.md
        finalize-merge-gate.md
        memory-governance.md

      meta/
        skill-pressure-evaluation.md
        skill-token-budget.md

  prompts/
    _prompt-constraints.md
    _common-footer.md
    master-planner.md
    ...
```

`upstream-superpowers/` 用来保留原始 skill 版本和来源；真正被 prompt loader 注入的是 `minimum-adapted/`。

---

# 3. 原始 Superpowers skill 拆解映射

| Upstream skill                   | Minimum-adapted skill       | 用途                              |
| -------------------------------- | --------------------------- | ------------------------------- |
| `writing-plans`                  | `contract-first-planning`   | 把 plan 映射成 TaskContract         |
| `writing-plans`                  | `task-granularity`          | 控制任务粒度                          |
| `writing-plans`                  | `no-placeholder-plan`       | 禁止 TBD/TODO/模糊任务                |
| `subagent-driven-development`    | `subagent-task-assignment`  | 强化 master 分配任务                  |
| `subagent-driven-development`    | `context-isolated-dispatch` | 限制 worker 上下文                   |
| `subagent-driven-development`    | `worker-status-protocol`    | 统一 completed / blocked / failed |
| `subagent-driven-development`    | `blocked-escalation`        | blocked 后 repair routing        |
| `test-driven-development`        | `red-test-contract`         | RED 测试约束                        |
| `test-driven-development`        | `green-verification`        | GREEN 验证约束                      |
| `test-driven-development`        | `test-quality-review`       | 测试质量审查                          |
| `test-driven-development`        | `test-exception-policy`     | 测试豁免策略                          |
| `requesting-code-review`         | `spec-compliance-review`    | 规格符合性审查                         |
| `requesting-code-review`         | `code-quality-review`       | 代码质量审查                          |
| `requesting-code-review`         | `review-severity-policy`    | severity 阻塞策略                   |
| `finishing-a-development-branch` | `finalize-merge-gate`       | W4 merge gate                   |
| `finishing-a-development-branch` | `memory-governance`         | memory candidate 处理             |
| `writing-skills`                 | `skill-pressure-evaluation` | 用 pressure scenario 测 skill     |
| `writing-skills`                 | `skill-token-budget`        | 控制 skill 上下文体积                  |

`writing-plans` 原始 skill 要求 exact file paths、bite-sized tasks、No Placeholders、自审，并禁止 TBD/TODO/“handle edge cases”这类不可执行计划。([GitHub][2]) 这些很适合迁移到 `minimum` 的 W0/W0.5，而不是保留为 Markdown plan 文件。

---

# 4. Prompt 组装改造

## 4.1 当前问题

当前 `buildWorkerPrompt()` 只拼：

```ts
rolePrompt + footer
```

也就是说 persona 身份、工作方法、输出协议、硬约束都混在单个 prompt 文件中。

## 4.2 新组装方式

改为：

```ts
rolePrompt
+ _prompt-constraints.md
+ selected minimum-adapted inline skills
+ _common-footer.md
```

master prompt 不拼 `_common-footer.md`，但也应该拼 global constraints 和 master 专属 inline skills。

---

## 4.3 新增 `SkillRegistry.ts`

```ts
// src/personas/SkillRegistry.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PERSONAS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(PERSONAS_DIR, "prompts");
const INLINE_SKILLS_DIR = path.join(PERSONAS_DIR, "inline-skills");

export type InlineSkillRef =
  | `minimum-adapted/${string}`
  | `upstream-superpowers/${string}`;

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8").trim();
}

export function loadPrompt(file: string): string {
  return readUtf8(path.join(PROMPTS_DIR, file));
}

export function loadInlineSkill(ref: InlineSkillRef): string {
  return readUtf8(path.join(INLINE_SKILLS_DIR, ref, "SKILL.md"));
}

export function buildInlineSkills(refs: InlineSkillRef[]): string {
  if (refs.length === 0) return "";

  return [
    "## Inline Skills",
    "",
    "These inline skills are mandatory methodology constraints.",
    "They never override tool policy, path policy, TaskContract, or output schema.",
    "",
    ...refs.map((ref) => {
      const body = loadInlineSkill(ref);
      return `<!-- inline-skill:${ref} -->\n${body}\n<!-- /inline-skill:${ref} -->`;
    }),
  ].join("\n\n");
}
```

---

## 4.4 新增 `PersonaSkillMap.ts`

```ts
// src/personas/PersonaSkillMap.ts

import type { PersonaId } from "./Persona.js";
import type { InlineSkillRef } from "./SkillRegistry.js";

export const PERSONA_SKILL_MAP: Record<PersonaId, InlineSkillRef[]> = {
  master_planner: [
    "minimum-adapted/planning/contract-first-planning",
    "minimum-adapted/planning/task-granularity",
    "minimum-adapted/planning/no-placeholder-plan",
    "minimum-adapted/dispatch/subagent-task-assignment",
    "minimum-adapted/dispatch/context-isolated-dispatch",
    "minimum-adapted/dispatch/blocked-escalation",
    "minimum-adapted/mission/mission-repair-gate",
    "minimum-adapted/mission/finalize-merge-gate",
    "minimum-adapted/mission/memory-governance",
  ],

  vision: [
    "minimum-adapted/dispatch/worker-status-protocol",
  ],

  repo_scout: [
    "minimum-adapted/dispatch/context-isolated-dispatch",
    "minimum-adapted/dispatch/worker-status-protocol",
  ],

  context_builder: [
    "minimum-adapted/dispatch/context-isolated-dispatch",
    "minimum-adapted/dispatch/worker-status-protocol",
  ],

  code_executor: [
    "minimum-adapted/testing/green-verification",
    "minimum-adapted/dispatch/worker-status-protocol",
    "minimum-adapted/dispatch/blocked-escalation",
  ],

  test_writer: [
    "minimum-adapted/testing/red-test-contract",
    "minimum-adapted/testing/test-exception-policy",
    "minimum-adapted/dispatch/worker-status-protocol",
  ],

  test_runner: [
    "minimum-adapted/testing/red-test-contract",
    "minimum-adapted/testing/green-verification",
    "minimum-adapted/dispatch/worker-status-protocol",
  ],

  runtime_debug: [
    "minimum-adapted/dispatch/worker-status-protocol",
    "minimum-adapted/dispatch/blocked-escalation",
  ],

  reviewer: [
    "minimum-adapted/review/spec-compliance-review",
    "minimum-adapted/review/code-quality-review",
    "minimum-adapted/review/review-severity-policy",
    "minimum-adapted/testing/test-quality-review",
  ],

  docs: [
    "minimum-adapted/mission/finalize-merge-gate",
    "minimum-adapted/mission/memory-governance",
    "minimum-adapted/dispatch/worker-status-protocol",
  ],
};
```

第一版不新增 persona。`test_impact_scout`、`test_triage`、`test_quality_reviewer` 可以作为第二阶段扩展，而不是本轮必须落地。

---

# 5. `master_planner` 的核心改造

## 5.1 新增 adapted skill：`subagent-task-assignment`

文件：

```text
src/personas/inline-skills/minimum-adapted/dispatch/subagent-task-assignment/SKILL.md
```

内容：

```md
---
name: subagent-task-assignment
description: Use inside master_planner when converting user requests into Minimum TaskContracts and dispatch order.
derived_from:
  - superpowers/subagent-driven-development
---

# Subagent Task Assignment for Minimum

Use this skill when assigning tasks to fixed Minimum personas.

## Core Rule

Each Task must behave like a fresh isolated subagent invocation:

- one persona
- one objective
- one bounded writable surface
- one ContextPack
- one verifiable output
- one clear blocked protocol

Do not create tasks that require the worker to infer architecture, inspect the full repository, or decide scope.

## Assignment Procedure

For every user requirement:

1. Identify the smallest independently verifiable work slice.
2. Classify the slice:
   - perception
   - repository scouting
   - context building
   - test writing
   - test execution
   - implementation
   - runtime debugging
   - review
   - documentation
3. Assign exactly one persona.
4. Add dependencies so the worker receives only required upstream evidence.
5. Add a review gate after every behavior-changing implementation.
6. Add a repair route for blocked or failed reports.

## Task Quality Checklist

A task is dispatchable only if:

- objective states expected artifact
- objective states non-goals
- allowedGlobs are minimal
- acceptance criteria are observable
- ContextPack source is known
- dependency order provides required evidence
- no same-batch writer overlaps writable files
- reviewer task exists when behavior changes

## Review Gate Rule

For every implementation task that changes behavior:

1. test evidence must exist or be explicitly waived
2. reviewer must run spec compliance first
3. reviewer may run code quality only after spec compliance passes
4. docs may run only after implementation, test, and review evidence

## Status Routing

If worker reports:

- completed: route to required validation/review
- blocked: inspect blocker and create repair task with changed context, narrower scope, or better owner
- failed: route to runtime_debug, test_runner, or code_executor depending on failure class

Never retry the same task unchanged.
Never ignore a blocked report.
Never accept implementer self-review as final review.

## Parallelism Rule

Parallel implementation is allowed only when:

- allowedGlobs are disjoint
- dependencies are independent
- no shared generated files are touched
- no shared global config is modified
- review tasks depend on all related implementation/test tasks

If uncertain, serialize.
```

---

## 5.2 追加进 `master-planner.md`

放在当前 `## Hard Rules` 后、`## DAG Output` 前。当前 master prompt 已经定义了职责、hard rules、DAG output、refine output、finalize output；新增段落应该增强“如何分配任务”，而不是替换原有 schema。

追加：

```md
## Subagent-Driven Task Assignment

Use Subagent-Driven Development as a task assignment policy, not as a separate workflow.

In Minimum, a "subagent" means one fixed Persona executing one TaskContract with isolated context.

### Core Principle

Fresh isolated task + precise ContextPack + review gate = reliable execution.

Every task you create must be small enough that the assigned persona can complete it without reading the whole repository or making architecture decisions.

### Assignment Algorithm

For each user requirement:

1. Convert the requirement into the smallest independently verifiable slice.
2. Classify the slice:
   - perception
   - repository scouting
   - context building
   - test writing
   - test execution
   - implementation
   - runtime debugging
   - review
   - documentation
3. Assign exactly one persona from the fixed registry.
4. Give the task only the context it needs.
5. Add dependencies so required upstream evidence exists before execution.
6. Add validation and review tasks after behavior-changing implementation.
7. Add repair routing for blocked or failed outcomes.

### Persona Selection Rules

Use `vision` only for visual artifacts.

Use `repo_scout` when file locations, existing abstractions, or test commands are unknown.

Use `context_builder` when downstream workers need a bounded ContextPack instead of broad perception reports.

Use `test_writer` only for writing or modifying tests.

Use `test_runner` only for executing explicit commands and reporting compact evidence.

Use `code_executor` only for production implementation inside allowedGlobs.

Use `runtime_debug` only for diagnosing logs, stack traces, build failures, runtime failures, and environment issues.

Use `reviewer` for spec compliance and code quality review. The review must run in this order:

1. spec compliance
2. code quality

Use `docs` only after implementation, test evidence or waiver, and review evidence exist.

### Task Granularity Rules

Good task units:

- identify relevant files
- build one ContextPack
- add one behavior test
- run one targeted test command
- implement one minimal behavior slice
- diagnose one failure class
- review one patch set
- update one documentation surface

Bad task units:

- implement feature
- fix all tests
- refactor module
- update code and docs
- handle edge cases
- improve robustness

Split any task that mixes personas, tools, or unrelated writable paths.

### Context Isolation Rules

No worker receives the full repository as implicit context.

Every worker task must include:

- objective
- non-goals
- allowedGlobs
- forbiddenGlobs
- acceptance criteria
- required upstream reports
- ContextPack or ContextPack source
- expected output
- blocked condition

Do not make a worker read a plan file or infer missing task details. Provide the full task text and exact context.

### Dependency Rules

For behavior-changing work, prefer this order:

1. repo_scout
2. context_builder if needed
3. test_writer
4. test_runner for RED evidence when applicable
5. code_executor
6. test_runner for GREEN evidence
7. reviewer
8. docs

If tests are not applicable, include an explicit test waiver in acceptance or constraints.

Docs must depend on implementation, test evidence or waiver, and reviewer result.

Reviewer must depend on implementation and relevant test evidence.

### Parallelism Rules

Parallelize only when all are true:

- tasks are independent
- writable surfaces are disjoint
- no shared generated files are touched
- no shared global configuration is touched
- neither task depends on the other task's output

If uncertain, serialize.

Never place two write-capable tasks in the same parallelGroup when their allowedGlobs overlap or one glob contains the other.

### Review Gate Rules

Every behavior-changing implementation must have a review gate.

The review gate must check:

1. Spec compliance:
   - matches original user request
   - satisfies TaskContract acceptance
   - no unrequested behavior
   - no out-of-contract file changes
   - test evidence exists or is waived

2. Code quality:
   - follows existing abstractions
   - has reasonable error handling
   - avoids hidden side effects
   - does not introduce security risk
   - remains maintainable

Do not allow code quality approval before spec compliance passes.

Do not let implementer self-review replace reviewer review.

### Worker Status Handling

If a worker reports `completed`:
- route to the next validation, review, or documentation task.

If a worker reports `blocked`:
- identify whether the blocker is context, path, tool, dependency, ambiguity, or design.
- create a repair task with changed context, changed owner, narrower scope, or better dependency.
- do not retry the same task unchanged.

If a worker reports `failed`:
- route to the most precise diagnostic owner:
  - test failure → test_runner or runtime_debug
  - implementation gap → code_executor
  - invalid test → test_writer
  - missing repo evidence → repo_scout
  - bad context → context_builder
  - spec mismatch → reviewer or return to W0.5

### Continuous Execution Rule

Do not insert human check-ins between tasks.

Only stop with `NEEDS_HUMAN_CONFIRMATION` when:

- user intent is ambiguous enough to make automatic repair unsafe
- destructive migration is required
- credentials or secrets are required
- external access is required
- TaskContract cannot be safely refined
```

---

# 6. 其他 adapted skills 内容

## 6.1 `contract-first-planning`

```md
---
name: contract-first-planning
description: Use when converting user requirements into Minimum DAG tasks or refined TaskContracts.
derived_from:
  - superpowers/writing-plans
---

# Contract-First Planning

Every executable task must become a TaskContract.

A valid TaskContract contains:

- objective
- persona
- allowedGlobs
- forbiddenGlobs
- acceptance criteria
- dependencies
- contextPack or contextPackPath when needed

Prefer exact paths over broad globs.
Broad globs require rationale.

Do not launch tasks with vague objective, missing acceptance, missing context, or unsafe writable surface.
```

---

## 6.2 `task-granularity`

```md
---
name: task-granularity
description: Use when splitting a user request into executable Minimum DAG tasks.
derived_from:
  - superpowers/writing-plans
---

# Task Granularity

Each task should produce one independently reviewable artifact.

Good task units:

- one behavior test
- one minimal implementation slice
- one targeted test command
- one review pass
- one documentation update

Bad task units:

- implement feature
- fix all tests
- refactor module
- update docs and code
- handle edge cases

Split when a task needs unrelated files, unrelated tools, or mixed persona responsibilities.
```

---

## 6.3 `no-placeholder-plan`

```md
---
name: no-placeholder-plan
description: Use when validating W0 DAGs or W0.5 TaskContracts for vague, incomplete, or non-executable instructions.
derived_from:
  - superpowers/writing-plans
---

# No Placeholder Plan

Never emit:

- TBD
- TODO
- implement later
- fill in details
- add proper validation
- handle edge cases
- write tests for the above
- similar to previous task

Every task must include:

- exact objective
- exact output
- exact allowedGlobs when known
- exact acceptance evidence
- exact dependency requirements

If exact data is unavailable, mark needs_refine or return blocked.
```

---

## 6.4 `red-test-contract`

```md
---
name: red-test-contract
description: Use when writing tests before implementation for a feature, bugfix, refactor, or behavior change.
derived_from:
  - superpowers/test-driven-development
---

# Red Test Contract

Before production implementation, create one minimal behavioral test for one acceptance criterion.

A valid RED test must:

- map to exactly one acceptance criterion
- have a clear behavior-focused name
- exercise public behavior when possible
- avoid mocks unless unavoidable
- be expected to fail before implementation
- fail for the expected missing behavior, not syntax or setup error

If the test passes immediately, it is not valid RED evidence.
If the test errors instead of failing behaviorally, fix the test setup before implementation.

Do not write production code.
```

Superpowers 原始 TDD skill 的核心原则是先写测试、看它失败、再写最小代码通过；它也强调没有看过测试失败，就不能确认这个测试真的测对了东西。([GitHub][3])

---

## 6.5 `green-verification`

```md
---
name: green-verification
description: Use when implementing minimal production code after a valid failing test exists.
derived_from:
  - superpowers/test-driven-development
---

# Green Verification

Implement the smallest production change that makes the RED test pass.

Rules:

- do not add unrequested behavior
- do not refactor unrelated files
- do not change the test to make it pass
- do not claim GREEN without test_runner evidence
- if the required implementation is outside allowedGlobs, return blocked

Valid GREEN evidence requires:

- command
- exit code
- passing target test
- no new blocking failures
```

---

## 6.6 `test-exception-policy`

```md
---
name: test-exception-policy
description: Use when deciding whether a TaskContract may skip RED-GREEN testing.
derived_from:
  - superpowers/test-driven-development
---

# Test Exception Policy

Testing may be waived only when the TaskContract is:

- docs-only
- generated code
- throwaway prototype
- config-only with no executable behavior
- impossible to test in the available environment

A waiver must include:

- reason
- affected acceptance criteria
- alternative evidence
- reviewer confirmation

Do not silently skip tests.
Do not use "too simple" as a waiver reason.
```

---

## 6.7 `spec-compliance-review`

```md
---
name: spec-compliance-review
description: Use when checking whether a patch satisfies the user request and TaskContract acceptance criteria.
derived_from:
  - superpowers/subagent-driven-development
  - superpowers/requesting-code-review
---

# Spec Compliance Review

Run this review before code quality review.

Reject or require revision when:

- patch touches files outside allowedGlobs
- acceptance criteria are incomplete
- implementation adds unrequested behavior
- test evidence is missing or invalid
- behavior differs from original user request
- docs describe behavior not implemented

If spec compliance fails, final decision cannot be approve.
```

---

## 6.8 `code-quality-review`

```md
---
name: code-quality-review
description: Use after spec compliance passes, when evaluating maintainability, integration risk, safety, and hidden side effects.
derived_from:
  - superpowers/subagent-driven-development
  - superpowers/requesting-code-review
---

# Code Quality Review

Run only after spec compliance passes.

Review:

- interface consistency
- reuse of existing abstractions
- error handling
- security risks
- hidden side effects
- maintainability
- test robustness
- integration risks

Do not approve if quality issues can break required behavior.
```

---

## 6.9 `review-severity-policy`

```md
---
name: review-severity-policy
description: Use when assigning review severity and deciding whether work may continue.
derived_from:
  - superpowers/requesting-code-review
---

# Review Severity Policy

Severity:

- Critical: correctness, security, data loss, contract violation
- Important: likely bug, maintainability risk, missing coverage, integration risk
- Minor: style, naming, cleanup, non-blocking improvement

Policy:

- Critical blocks immediately
- Important must be fixed before W4 unless explicitly waived
- Minor may be recorded for later

Do not ignore valid Critical or Important issues.
```

---

## 6.10 `mission-repair-gate`

```md
---
name: mission-repair-gate
description: Use during W3.5 when deciding whether the mission may enter W4 or needs automatic repair.
derived_from:
  - superpowers/subagent-driven-development
  - superpowers/finishing-a-development-branch
---

# Mission Repair Gate

APPROVED_TO_W4 only when:

- original user request is satisfied
- every acceptance criterion has evidence
- required tests passed or have explicit waiver
- reviewer has no high severity issue
- no worker is blocked, failed, or contract_invalid
- no out-of-contract files changed
- docs do not describe unverified behavior

LOOP_BACK_TO_W1 means automatic repair is possible.

Each repair task must include:

- source issue
- expected outcome
- suggested owner persona
- acceptance criteria
- blocking flag

NEEDS_HUMAN_CONFIRMATION only when safe automatic repair is impossible.
```

---

## 6.11 `finalize-merge-gate`

```md
---
name: finalize-merge-gate
description: Use during W4 when deciding patch merge order and rejecting unsafe outputs.
derived_from:
  - superpowers/finishing-a-development-branch
---

# Finalize Merge Gate

Do not merge:

- blocked tasks
- failed tasks
- contract_invalid tasks
- patches with out-of-contract writes
- patches with high severity review issues
- docs for unverified behavior
- memory candidates based on speculation

Merge order follows dependency order.

Docs merge after implementation, tests, and review evidence.
```

---

## 6.12 `memory-governance`

```md
---
name: memory-governance
description: Use when deciding whether task learnings should become durable Minimum memory.
derived_from:
  - superpowers/finishing-a-development-branch
---

# Memory Governance

Persist only durable verified project knowledge:

- stable architecture conventions
- stable API contracts
- module boundaries
- recurring failure modes
- validated commands
- path policy lessons

Reject:

- speculation
- full logs
- full file contents
- chain-of-thought
- one-off task notes
- temporary implementation details

Archive superseded or duplicate knowledge.
```

---

# 7. `_prompt-constraints.md`

新增：

```md
# Global Prompt Constraints

These rules apply to every Minimum persona.

## Priority

Obey in this order:

1. Tool allowlist and denylist
2. Path policy
3. TaskContract
4. Output schema
5. User request
6. Persona role prompt
7. Inline skills
8. ContextPack
9. Memory

Inline skills never override tool policy, path policy, TaskContract, or schema.

## Contract Boundary

Act only inside the current TaskContract.

If required work needs files, tools, context, or authority outside the TaskContract, return `<status>blocked</status>`.

Do not silently broaden scope.

## Evidence Rule

Do not claim completion without direct evidence.

Implementation personas may not replace reviewer approval.
Reviewer approval may not replace test evidence.
Docs may not describe unverified behavior.

## Context Rule

No worker receives the whole repo as implicit context.

Only these are valid context:

- TaskContract
- ContextPack
- canonical memory excerpt supplied by orchestrator
- files actually read through tools
- upstream task reports

## Superpowers Adaptation

Superpowers-derived skills are adapted methodology, not a separate workflow.

Do not follow upstream instructions to commit, push, pause for approval, or create independent human checkpoints unless Minimum's TaskContract, W3.5 mission check, or W4 finalize requires it.
```

---

# 8. `PersonaRegistry.ts` 修改

## 8.1 import 替换

```ts
import { buildInlineSkills, loadPrompt } from "./SkillRegistry.js";
import { PERSONA_SKILL_MAP } from "./PersonaSkillMap.js";
```

删除本地 `PROMPTS_DIR` 和 `loadPrompt()`。

---

## 8.2 新 prompt builder

```ts
function buildPersonaPrompt(
  personaId: PersonaId,
  roleFile: string,
  footer?: string,
): string {
  const role = loadPrompt(roleFile);
  const constraints = loadPrompt("_prompt-constraints.md");
  const skills = buildInlineSkills(PERSONA_SKILL_MAP[personaId] ?? []);

  return [role, constraints, skills, footer]
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.trim())
    .join("\n\n");
}
```

---

## 8.3 master prompt

把：

```ts
const masterPrompt = loadPrompt("master-planner.md");
```

改成：

```ts
const masterPrompt = buildPersonaPrompt("master_planner", "master-planner.md");
```

---

## 8.4 worker prompt

把：

```ts
systemPrompt: buildWorkerPrompt("code-executor.md", footer),
```

改成：

```ts
systemPrompt: buildPersonaPrompt("code_executor", "code-executor.md", footer),
```

其余 persona 同理。

---

# 9. W0 / W0.5 输出变化

## 9.1 W0 coarse DAG 变化

旧风格：

```json
{
  "id": "T2-1",
  "persona": "code_executor",
  "objective": "Implement upload size validation",
  "allowedGlobs": ["TBD-after-refine"],
  "needs_refine": true,
  "parallelGroup": "backend"
}
```

新风格：

```json
{
  "id": "T2-1",
  "persona": "code_executor",
  "objective": "Implement the minimal production change that rejects uploads over 5MB. Non-goals: do not change auth, storage, UI, or docs. Expected artifact: production patch only. Evidence required: GREEN test_runner result or explicit test waiver. Blocked if required files are outside allowedGlobs.",
  "allowedGlobs": ["TBD-after-refine"],
  "needs_refine": true,
  "parallelGroup": "backend-implementation",
  "dependsOn": ["T1-repo-scout", "T2-red-test"]
}
```

---

## 9.2 Review task 变化

```json
{
  "id": "T3-review",
  "persona": "reviewer",
  "objective": "Review the implementation patch. First check spec compliance against the original user request and TaskContract acceptance. Only if spec compliance passes, check code quality, integration risk, security, and maintainability. Reject if implementation adds unrequested behavior or lacks test evidence.",
  "needs_refine": true,
  "parallelGroup": "review",
  "dependsOn": ["T2-implementation", "T2-green-test"]
}
```

---

## 9.3 W0.5 refine 变化

当前 refine output 支持 `allowedGlobs`、`forbiddenGlobs`、`acceptance`、`constraints`、`contextPack`，但旧 prompt 里这些字段是 optional。 引入后建议对 write-capable task 强制要求：

```json
{
  "taskId": "T2-implementation",
  "allowedGlobs": [
    "src/api/upload.ts"
  ],
  "forbiddenGlobs": [
    "src/auth/**",
    "src/storage/**",
    "README.md",
    "docs/**"
  ],
  "acceptance": [
    "Rejects files over 5MB with project-standard error format",
    "Preserves existing successful upload behavior",
    "Does not alter auth, storage, or UI flow",
    "GREEN test_runner evidence exists or testing waiver is explicit"
  ],
  "constraints": [
    "Use existing upload validation pattern if present",
    "Do not introduce new dependency",
    "If validation helper is outside allowedGlobs, return blocked"
  ],
  "contextPack": "# Context Pack: T2-implementation\n\n## Goal\nImplement only upload size rejection.\n\n## Non-Goals\n- auth\n- storage\n- UI\n- docs\n\n## Read First\n- src/api/upload.ts\n- tests/api/upload.test.ts\n\n## Required Upstream Evidence\n- repo_scout report\n- RED test report\n"
}
```

---

# 10. Master Planner 决策表

加入 master prompt 或 `subagent-task-assignment` skill：

| 情况           | 选 persona         | 典型 dependsOn                     | 不应交给                |
| ------------ | ----------------- | -------------------------------- | ------------------- |
| 有截图、设计稿、视觉对齐 | `vision` | 用户输入                             | `code_executor`     |
| 不知道文件位置      | `repo_scout` | 无                                | `code_executor`     |
| 下游上下文太大      | `context_builder` | `repo_scout` / `vision`          | master 硬塞全上下文       |
| 需要写测试        | `test_writer` | `repo_scout` / `context_builder` | `code_executor`     |
| 需要跑命令        | `test_runner` | `test_writer` / `code_executor`  | `code_executor`     |
| 需要改生产代码      | `code_executor` | scout/context/test               | `test_writer`       |
| 测试、构建、运行失败诊断 | `runtime_debug` | `test_runner`                    | `code_executor` 直接猜 |
| patch 验收     | `reviewer` | implementation + test evidence   | implementer 自审      |
| 用户文档         | `docs`            | reviewer approve                 | `code_executor`     |

---

# 11. 第一阶段不新增 persona

本轮主线：

```text
不新增 persona
不改主流水线
只新增 adapted skills
只增强 prompt assembly
只强化 master_planner dispatch policy
```

原因：

1. 当前固定 persona roster 是项目有意设计。
2. 最新目标是“拆解和改造 Superpowers 的 skills 文件”，而不是重构调度器。
3. 先让 master 更会分配任务，收益最大、风险最低。

第二阶段可以考虑新增：

```text
test_impact_scout
test_triage
test_quality_reviewer
```

但不纳入第一阶段主方案。

---

# 12. Pressure scenarios

根据 Superpowers `writing-skills` 的思路，skill 应该通过 pressure scenario 验证，而不是靠直觉扩写。它强调先观察无 skill 时的失败，再写 skill 修复具体失败。([GitHub][2])

新增：

```text
eval/persona-pressure/
  master-planner-dispatch.yaml
  testing-skills.yaml
  review-skills.yaml
  mission-gate.yaml
```

## 12.1 `master-planner-dispatch.yaml`

```yaml
- id: overbroad_implementation_task
  persona: master_planner
  input: "Add upload preview and reject files over 5MB."
  fail_if:
    - objective: "Implement upload feature"
    - missing_dependsOn: true
    - missing_review_task: true
  expected:
    - has_repo_scout: true
    - has_test_writer: true
    - has_code_executor: true
    - has_test_runner: true
    - has_reviewer: true
    - implementation_task_has_non_goals: true

- id: docs_before_review
  persona: master_planner
  input: "Update API behavior and docs."
  fail_if:
    - docs_depends_only_on_implementation: true
  expected:
    - docs_depends_on:
        - implementation
        - test_evidence_or_waiver
        - reviewer
```

## 12.2 `review-skills.yaml`

```yaml
- id: code_quality_before_spec
  persona: reviewer
  input:
    patch: "implements extra --json flag not requested"
    acceptance:
      - "add progress reporting"
  fail_if:
    - decision: approve
    - code_quality_review_before_spec: true
  expected:
    decision: needs_revision
    spec_compliance_passes: false
```

## 12.3 `testing-skills.yaml`

```yaml
- id: green_claim_without_runner
  persona: code_executor
  input:
    tools_denied:
      - exec_shell
    output_claim: "tests passed"
  fail_if:
    - test_result: passed
  expected:
    test_result: not_run_or_provided_pass_only
```

---

# 13. Commit 拆分

推荐 5 个 commit：

```text
commit 1:
  chore(skills): vendor upstream superpowers skill references

commit 2:
  feat(skills): add minimum-adapted planning, dispatch, testing, review, mission skills

commit 3:
  feat(personas): add inline skill registry and persona skill map

commit 4:
  feat(master-planner): integrate subagent task assignment dispatch policy

commit 5:
  test(eval): add pressure scenarios for dispatch, review, testing, and mission gates
```

---

# 14. 落地顺序

## Phase A：最小接入

只做：

```text
SkillRegistry.ts
PersonaSkillMap.ts
_prompt-constraints.md
subagent-task-assignment.md
master-planner.md 追加调度规则
```

验证目标：

```text
master_planner 能生成更细粒度 DAG
reviewer/test/docs dependencies 更准确
write-capable tasks 有 non-goals / acceptance / blocked condition
```

---

## Phase B：Superpowers skill 拆解

加入：

```text
planning/*
dispatch/*
testing/*
review/*
mission/*
```

验证目标：

```text
code_executor 不再声称自己跑过测试
reviewer 按 spec → quality 顺序审查
MissionChecker 不放过部分完成任务
docs 不记录未验证行为
```

---

## Phase C：pressure scenarios

加入 eval：

```text
master-planner-dispatch.yaml
testing-skills.yaml
review-skills.yaml
mission-gate.yaml
```

验证目标：

```text
每个 skill 都对应至少一个真实失败模式
没有无意义扩写
没有重复工具/路径策略中已有的硬规则
```

---

## Phase D：可选测试 persona 拆分

只有当 Phase A–C 稳定后，再考虑：

```text
test_impact_scout
test_triage
test_quality_reviewer
```

这不是第一阶段必须项。

---

# 15. 成功标准

引入完成后，`master_planner` 应具备以下行为：

```text
1. 不再生成“implement feature”这种粗任务。
2. 每个 write-capable task 都有 non-goals、allowedGlobs、acceptance、blocked condition。
3. 行为变更默认有 test_writer → test_runner → code_executor → test_runner → reviewer。
4. reviewer 任务明确要求 spec compliance 先于 code quality。
5. docs 任务一定晚于 implementation、test evidence/waiver、reviewer。
6. blocked task 不会原样重试，而是创建 changed-context / changed-owner / narrower-scope repair task。
7. 并行任务只在 allowedGlobs 绝对不重叠时生成。
8. W3.5 可以基于 evidence 判断 APPROVED_TO_W4 / LOOP_BACK_TO_W1 / NEEDS_HUMAN_CONFIRMATION。
```

---

# 16. 最终结论

完整引入方案是：

```text
Superpowers 原始 skill
  ↓
拆解为 minimum-adapted inline skills
  ↓
通过 SkillRegistry 注入 persona prompt
  ↓
重点把 subagent-driven-development 改造成 master_planner dispatch policy
  ↓
用 pressure scenarios 验证任务分配、测试、审查、回环是否稳定
```

[1]: https://raw.githubusercontent.com/obra/superpowers/main/skills/subagent-driven-development/SKILL.md "raw.githubusercontent.com"
[2]: https://raw.githubusercontent.com/obra/superpowers/main/skills/writing-plans/SKILL.md "raw.githubusercontent.com"
[3]: https://raw.githubusercontent.com/obra/superpowers/main/skills/test-driven-development/SKILL.md "raw.githubusercontent.com"
