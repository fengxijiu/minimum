## 总体判断

你现在的 persona 体系已经有比较完整的工程骨架：固定 roster、每个 persona 独立 prompt、工具白名单/黑名单、路径策略、并发限制、统一 worker 输出协议。`PersonaRegistry` 明确固定了 10 个 persona，并要求 `master_planner` 只能从固定 ID 中选择，不能用 `developer/tester/qa` 这类同义词。

优化重点不是继续加 persona，而是让每个 persona 的**边界更硬、输出更可校验、失败更可追踪**。

---

# 1. 全局优化方向

## 1.1 给所有 persona 加“真实性协议”

你现在 `_common-footer.md` 已经要求所有 worker 最终只输出两个 XML block：`<task_report>` 和 `<memory_candidate>`，并且禁止输出推理过程、未验证结论和完整日志。

建议把 worker 通用协议再强化成：

```md
## Evidence Rules

- Do not claim a file exists unless it was observed by tool output.
- Do not claim tests passed unless test_runner produced a passing report.
- Mark every uncertain claim under `<uncertainty>`.
- If evidence is missing, set `<status>blocked</status>` instead of guessing.
```

这样可以降低 persona 幻觉式接力的问题。

---

## 1.2 给每个 persona 加“不可做事项”

现在很多 prompt 已有 Hard Rules，但格式不完全一致。建议统一增加：

```md
## Must Not Do

- ...
```

原因是模型对“职责描述”经常会过度扩展；`Must Not Do` 比单纯 `Responsibilities` 更稳定。

---

## 1.3 输出结构再机器可读一点

现在很多 prompt 的 `<task_report>` 里是半结构化 XML + markdown。建议统一加：

```xml
<evidence>
  - source: ...
    claim: ...
</evidence>

<uncertainty>
  - ...
</uncertainty>

<blocked_reason>
  ...
</blocked_reason>
```

这样 W3.5 / mission checker 更容易判断“是否真的完成”。

---

# 2. 各 persona 优化建议

## 2.1 `master_planner`

### 当前定位

`master_planner` 负责把用户请求编译成可验证、可并行、可回滚的 task graph，不直接写业务代码。它还负责 persona 分配、冲突检测、W0.5 refine 和 W4 finalize。

### 主要问题

`master_planner` 当前职责很重：

```text
需求理解
任务拆分
persona 分配
路径约束
依赖图
W0.5 refine
W4 finalize
memory governance
```

这容易导致两个问题：

1. **任务拆分粒度不稳定**
2. **acceptance criteria 容易写成泛泛描述**

### 优化建议

给 `master_planner` 增加一个固定的拆分决策流程：

```md
## Planning Checklist

Before emitting `<task_dag>`, classify the request:

1. Is this analysis-only, implementation, debugging, testing, docs, or mixed?
2. Does it require visual input?
3. Does it require repo discovery?
4. Does it require tests before implementation?
5. What is the smallest safe implementation unit?
6. What evidence must exist before downstream tasks can launch?
```

再加入任务粒度规则：

```md
## Task Granularity Rules

- One task should have one owner persona.
- One task should have one primary deliverable.
- Do not combine implementation and verification in the same task.
- Do not create a code_executor task until repo_scout identifies relevant files.
- Prefer test_writer -> test_runner -> code_executor -> test_runner -> reviewer for behavior changes.
```

你已经在 master prompt 里写了推荐依赖形态：`test_writer -> test_runner -> code_executor -> test_runner -> reviewer`。建议把它从“prefer”提升成默认策略，除非任务显式 test-waived。

---

## 2.2 `vision`

### 当前定位

`vision` 只分析截图、设计稿、UI frame、chart，不写代码，也不分析仓库结构。prompt 里已经明确 repo 架构、依赖、文件列表属于 `repo_scout`。

### 主要问题

当前输出偏“视觉描述”，但对下游实现的约束还可以更强。

### 优化建议

增加三类字段：

```xml
<visual_evidence>
  - element: upload button
    location: bottom-right of upload card
    observed: true
</visual_evidence>

<responsive_unknowns>
  - mobile breakpoint not visible
  - hover state not provided
</responsive_unknowns>

<implementation_constraints>
  - preserve two-column ratio
  - primary CTA visually dominates secondary actions
</implementation_constraints>
```

并加入硬规则：

```md
- Do not infer backend behavior from UI screenshots.
- Do not invent hidden states not visible in the artifact.
- Separate visual facts from implementation suggestions.
```

---

## 2.3 `repo_scout`

### 当前定位

`repo_scout` 负责发现代码结构、入口、测试命令、相关文件、现有实现和重复风险，不修改文件。

### 主要问题

它现在会输出 `tech_stack`、`relevant_files`、`file_list`、`existing_patterns`、`test_commands`，但缺少**证据来源和置信度**。

### 优化建议

把 `repo_scout` 优化成“证据索引器”：

```xml
<relevant_files>
  - path: frontend/src/api/client.ts
    reason: existing API wrapper
    evidence: grep result matched "fetch"
    confidence: high
</relevant_files>

<test_commands>
  - command: npm run test
    source: package.json scripts.test
    confidence: high
</test_commands>

<missing_evidence>
  - no backend upload route found
</missing_evidence>
```

增加硬规则：

```md
- Do not list a file unless it was directly observed.
- Do not infer a test command unless it appears in package.json, config, or docs.
- Prefer fewer high-confidence files over broad file lists.
```

这会明显提高 `context_builder` 和 `master_planner.refine()` 的可靠性。

---

## 2.4 `context_builder`

### 当前定位

`context_builder` 把 vision/repo_scout/canonical memory 压缩成每个下游 task 的 ContextPack，且要求 ≤2000 tokens，不 echo 完整文件内容。 

### 主要问题

它当前容易变成“摘要器”，但更理想的是“下游执行约束生成器”。

### 优化建议

ContextPack 结构建议改成：

```md
# Context Pack: <taskId>

## Task Goal
...

## Must Use
- existing helper/function/module

## Must Avoid
- files / patterns / risky assumptions

## Relevant Evidence
- path: ...
  reason: ...
  source: repo_scout / vision / memory

## Acceptance Mapping
- acceptance item -> evidence needed

## Unknowns
- ...
```

重点是把 context 从“资料摘要”变成“执行边界 + 验收映射”。

---

## 2.5 `code_executor`

### 当前定位

`code_executor` 只在 Task Contract 范围内实现代码，输出 summary、changed files、patch、test command、test result、assumptions 和 risk notes。

### 主要问题

现在它被允许 `read_file/list_directory/grep/glob/write_file/edit_file/apply_patch/git_status/git_diff`，但禁止 `exec_shell`。也就是说它不能自己运行测试，只能提出 test command 或依赖 `test_runner`。

### 优化建议

强化三个点：

```md
## Implementation Discipline

- First state the intended edit in one sentence.
- Prefer minimal local patches.
- Do not refactor unless acceptance requires it.
- If tests cannot be run by this persona, set `<test_result>not_run</test_result>` and name the required test_runner command.
```

建议把输出改得更适合 reviewer 使用：

```xml
<acceptance_mapping>
  - criterion: rejects files >5MB
    implemented_by: src/api/upload.ts validation branch
    evidence: patch hunk
</acceptance_mapping>

<not_done>
  - ...
</not_done>
```

这样 reviewer 不需要重新推断实现是否覆盖 acceptance。

---

## 2.6 `test_writer`

### 当前定位

`test_writer` 只添加或扩展测试，不修改业务代码，不削弱断言，不删除或 skip 现有测试。

### 主要问题

当前 prompt 没有强制“测试应该先失败”。如果你想做 TDD 式可靠流水线，这是缺口。

### 优化建议

增加：

```md
## Test Intent Rules

- Prefer tests that fail before implementation and pass after implementation.
- Each test must map to one acceptance criterion.
- Do not test implementation details unless public behavior is insufficient.
- Do not add snapshot tests unless UI stability is the actual goal.
```

输出中增加：

```xml
<acceptance_coverage>
  - criterion: ...
    test: ...
    expected_failure_before_fix: true
</acceptance_coverage>
```

---

## 2.7 `test_runner`

### 当前定位

`test_runner` 只执行测试命令和解析失败，不修改代码。输出 command、exit_code、passed、failed、failures、root cause hint、suspected files。

### 主要问题

`test_runner` 容易把失败解释得过度确定。它应该区分：

```text
observed failure
likely root cause
suspected file
needs runtime_debug
```

### 优化建议

增加置信度：

```xml
<failure_analysis>
  - test: ...
    observed_error: ...
    root_cause_hint: ...
    confidence: low | medium | high
    needs_runtime_debug: true | false
</failure_analysis>
```

增加硬规则：

```md
- Do not claim root cause as fact unless directly shown by stack trace or assertion.
- If failure is environmental, mark as env_failure.
- If command was not found, report setup issue, not product failure.
```

---

## 2.8 `runtime_debug`

### 当前定位

`runtime_debug` 诊断 build errors、stack traces、port conflicts、env var issues、dependency mismatches，只报告 root cause，不 patch 业务代码。

### 主要问题

它现在只有 root cause 和 fix_rule，但没有“复现链路”和“证据强度”。

### 优化建议

输出改成：

```xml
<reproduction>
  <command>...</command>
  <symptom>...</symptom>
</reproduction>

<root_cause>
  <claim>...</claim>
  <evidence>...</evidence>
  <confidence>high | medium | low</confidence>
</root_cause>

<minimal_fix_scope>
  - file: ...
    reason: ...
</minimal_fix_scope>
```

增加硬规则：

```md
- Do not propose multiple unrelated fixes.
- Do not recommend dependency upgrades unless logs point to dependency mismatch.
- If evidence is insufficient, block and request missing log/config/repro.
```

---

## 2.9 `reviewer`

### 当前定位

`reviewer` 审计 patch 是否符合 Task Contract 和项目约定，不 merge，不修改代码。输出 approve / needs_revision / reject、risk_level、blocking issues、non-blocking suggestions。

### 主要问题

它现在有 review dimensions，但 decision threshold 可以更精确。

### 优化建议

增加决策标准：

```md
## Decision Threshold

Use `approve` only if:
- all acceptance criteria are satisfied or explicitly waived
- no protected path was modified
- tests are adequate or missing tests are non-blocking
- no high-risk hidden side effect is found

Use `needs_revision` if:
- the approach is mostly correct but has fixable gaps

Use `reject` if:
- wrong files were changed
- implementation contradicts requirements
- tests were weakened
- security risk is introduced
```

增加输出：

```xml
<acceptance_review>
  - criterion: ...
    status: pass | fail | unknown
    evidence: ...
</acceptance_review>
```

这能让 W3.5 判断更稳。

---

## 2.10 `docs`

### 当前定位

`docs` 只在主功能 patch 稳定后更新 README、docs、CHANGELOG 或已改文件中的 JSDoc/docstrings，不修改业务代码。 

### 主要问题

docs persona 容易写“理想功能”，而不是实际已合并功能。

### 优化建议

增加：

```md
## Documentation Truth Rules

- Document only behavior proven by final patch summary or test results.
- Do not describe features that are planned but not implemented.
- If implementation is partial, document limitations explicitly.
- Prefer command/API examples that match actual code.
```

输出中增加：

```xml
<source_of_truth>
  - final_patch_summary
  - changed_file_list
  - test_runner_report
</source_of_truth>

<documented_limitations>
  - ...
</documented_limitations>
```

---

# 3. Registry 层优化建议

## 3.1 `runtime_debug` 当前配置有一个小矛盾

`runtime_debug` 的 `pathPolicy.canWrite` 是 `false`，但 `alwaysAllowedGlobs` 里写了 `tasks/**/artifacts/**`。

这两者语义冲突：如果 `canWrite: false` 是硬规则，那么 `alwaysAllowedGlobs` 不会起作用。你有两个选择：

```ts
// 方案 A：完全只读
canWrite: false
alwaysAllowedGlobs: []

// 方案 B：允许写诊断 artifact
canWrite: true
alwaysAllowedGlobs: ["tasks/**/artifacts/**"]
toolAllowlist: [..., "write_file"]
```

我建议选 B，因为 runtime_debug 的诊断报告和 repro artifact 对 W3.5 很有价值。

---

## 3.2 `test_runner` 的 `exec_shell` 需要更细命令约束

`test_runner` 允许 `exec_shell`，但 prompt 只说“only exec_shell for test command + read tools”。

建议在 prompt 里更具体：

```md
Allowed command classes:
- package test scripts from repo_scout
- typecheck/lint commands from repo_scout
- no install
- no git mutation
- no server start unless explicitly assigned
```

否则 test_runner 可能会把“调试命令”也当成可执行范围。

---

## 3.3 `context_builder` 是否还需要独立 persona

`master_planner` prompt 里写了：W0.5 可以 inline context building，也可以分配 `context_builder`。

这会带来一个设计问题：**context_builder 的使用边界不明确**。

建议规则化：

```text
Use context_builder only when:
- task has more than 5 relevant files
- canonical memory must be selectively excerpted
- downstream worker has small token budget
- repo_scout + vision outputs need synthesis

Otherwise W0.5 inline contextPack is enough.
```

这样可以减少一次额外 agent 调用。

---

# 4. 建议的优先级

| 优先级 | persona           | 优化重点                                      |
| --- | ----------------- | ----------------------------------------- |
| P0  | `master_planner`  | 增加任务粒度、launch gate、ask_choice 触发规则        |
| P0  | `repo_scout`      | 增加 evidence/confidence，避免虚假文件列表           |
| P0  | `code_executor`   | 增加 acceptance_mapping 和 not_done          |
| P1  | `reviewer`        | 增加 decision threshold 和 acceptance_review |
| P1  | `test_runner`     | 区分 observed failure / inferred root cause |
| P1  | `runtime_debug`   | 修正 registry 写 artifact 的权限矛盾              |
| P2  | `context_builder` | 明确何时独立启用                                  |
| P2  | `test_writer`     | 增加 TDD/coverage mapping                   |
| P2  | `vision`          | 增加视觉证据和 unknowns                          |
| P3  | `docs`            | 增强“不写未实现功能”的真实性规则                         |

---

# 5. 最推荐的改法

先不要大改所有 persona。建议先落三类通用增强：

## A. 给 `_common-footer.md` 增加证据协议

```md
## Evidence Rules

- Never claim unobserved files, commands, or test results.
- Put unverified claims under `<uncertainty>`.
- If required evidence is missing, return `<status>blocked</status>`.
```

## B. 给关键执行链增加 acceptance mapping

影响：

```text
test_writer
code_executor
test_runner
reviewer
mission_checker
```

统一让它们围绕 acceptance criteria 交接。

## C. 修正 `runtime_debug` 写 artifact 权限

现在 registry 配置上有潜在矛盾，建议明确它到底是完全只读，还是允许写 `tasks/**/artifacts/**`。我倾向允许写诊断 artifact。
