下面是**方案三：Task Transaction + 多文件 Repair** 的无代码详细方案。

目标是把 worker 的一次执行从“单次写文件 + 失败回滚”升级为：

> **以任务为单位建立事务；允许 worker 在隔离环境内短暂保留失败修改并连续修复；只有最终验证通过的事务才能进入主工作区和下游任务。**

---

# 1. 设计目标

## 核心目标

1. **增强 worker 自纠错能力**

   * validator 失败后，不立即丢弃全部失败上下文。
   * worker 可以看到失败诊断、失败 diff、受影响文件、测试输出，并在同一个任务事务内继续修。

2. **支持多文件一致性**

   * 一次任务可能同时修改源文件、测试文件、配置文件。
   * 评估和回滚不再只围绕单个 `targetPath`，而是围绕整个 task transaction。

3. **避免坏代码污染主工作区**

   * 失败修改可以保留在 worker 的隔离 worktree 中。
   * 只有事务验证通过后，才允许 apply 回主项目。

4. **避免 worker 忽略验证失败**

   * 只要事务存在 unresolved validation failure，就不允许 worker 输出 completed。
   * worker 必须继续修复，或明确输出 blocked / failed。

5. **给 W3.5 更可靠的证据**

   * W3.5 不只看 worker 自报，还能看到事务级验证记录、失败次数、修复过程、最终测试证据。

---

# 2. 总体架构

新的任务完成评估体系分成四层：

| 层级 | 名称                       | 作用                      |
| -- | ------------------------ | ----------------------- |
| L1 | Task Contract Gate       | 判断任务是否可以启动              |
| L2 | Task Transaction Runtime | 管理本任务所有写入、快照、diff、验证、回滚 |
| L3 | Validation Repair Loop   | 允许 worker 基于失败证据自我修复    |
| L4 | Mission Acceptance Gate  | W3.5 做全局验收和回环判断         |

其中方案三主要改造 L2 和 L3。

---

# 3. 核心概念

## 3.1 Task Transaction

每个 worker task 启动时创建一个事务。

事务不是数据库事务，而是一个任务级执行容器，负责记录：

| 项                  | 内容            |
| ------------------ | ------------- |
| taskId             | 当前任务          |
| personaId          | 执行 persona    |
| objective          | 当前任务目标        |
| acceptance         | 当前任务验收项       |
| allowedGlobs       | 当前任务允许写入范围    |
| baseRevision       | 任务开始时的基准版本    |
| worktreePath       | 当前任务隔离工作区     |
| touchedFiles       | 任务期间修改过的文件    |
| preEditSnapshots   | 每个文件第一次修改前的快照 |
| failedDiffs        | 每次验证失败时的 diff |
| validationFailures | 所有验证失败记录      |
| repairAttempts     | 已使用的修复次数      |
| finalValidation    | 最终验证结果        |
| transactionStatus  | 当前事务状态        |

---

## 3.2 Transaction Status

建议定义这些状态：

| 状态                  | 含义                |
| ------------------- | ----------------- |
| `created`           | 事务已创建，worker 尚未写入 |
| `dirty`             | worker 已产生文件修改    |
| `validation_failed` | 至少一次 validator 失败 |
| `repairing`         | worker 正在基于失败信息修复 |
| `validated`         | 验证通过              |
| `committed`         | 事务变更已应用回主工作区      |
| `rolled_back`       | 事务已回滚             |
| `blocked`           | worker 明确无法完成     |
| `failed`            | 修复耗尽或出现不可恢复错误     |

---

## 3.3 Validation Failure

每次 validator 失败都要记录为结构化证据。

建议包含：

| 字段            | 说明                                                |
| ------------- | ------------------------------------------------- |
| failureId     | 本次失败编号                                            |
| attemptIndex  | 第几次失败                                             |
| checkerType   | syntax / typecheck / lint / test / build / custom |
| severity      | error / warning / blocking                        |
| affectedFiles | 受影响文件                                             |
| diagnostics   | 错误信息、行列号、测试断言、命令输出摘要                              |
| failedDiff    | 本次失败时的文件差异                                        |
| command       | 如果是命令型验证，记录命令                                     |
| exitCode      | 命令退出码                                             |
| timestamp     | 失败时间                                              |
| policy        | 本次失败适用的处理策略                                       |

---

# 4. 新执行流程

## 4.1 任务启动

worker task 被调度后：

1. 读取 `TaskContract`。
2. 校验 `allowedGlobs`、`acceptance`、`blockedCondition`。
3. 创建 task transaction。
4. 如果启用 worktree isolation，为该任务创建独立 worktree。
5. 记录 base revision。
6. worker 开始执行。

关键要求：

> 从这个阶段开始，所有写入、验证、diff、快照都必须绑定到 transaction，而不是散落在单个工具调用里。

---

## 4.2 worker 写入文件

worker 调用写工具时：

1. path policy 先检查是否允许写。
2. 如果是该文件第一次被修改，记录 pre-edit snapshot。
3. 执行写入。
4. 将文件加入 `touchedFiles`。
5. 标记事务状态为 `dirty`。
6. 触发轻量验证或延迟验证。

这里不要只记录单个 `targetPath`。即使本次工具只显式传了一个 path，也要从实际 diff 中识别真实 touched files。

---

## 4.3 validator 运行

validator 可以在三个时间点运行：

| 时机             | 作用               |
| -------------- | ---------------- |
| 写入后立即运行        | 快速发现语法/type 错误   |
| worker 主动运行测试时 | 捕获 test/build 失败 |
| task 准备完成前强制运行 | 防止 worker 跳过验证   |

推荐：

* 对小型 syntax/type validator：写入后自动跑。
* 对耗时 test/build：task 完成前或 contract 指定时跑。
* 对 `postStaticCompile.required`：必须在 completed 前通过。

---

## 4.4 validator 通过

如果 validator 通过：

1. 清除该文件或该验证项对应的 pending failure。
2. 更新事务的 final validation evidence。
3. 如果所有 blocking validator 均通过，则事务进入 `validated`。
4. worker 可以继续其他工作，或最终输出 completed report。

注意：通过一次 validator 不代表整个任务完成，只表示当前事务没有阻塞性验证失败。

---

## 4.5 validator 失败

这是方案三的核心。

失败后不再立即 restore，而是进入 repair loop。

流程：

1. 捕获 diagnostics。
2. 捕获 failed diff。
3. 记录 validation failure。
4. 标记事务状态为 `validation_failed`。
5. 根据 failure policy 决定处理方式：

   * 保留失败修改；
   * 回滚但保留 failed diff；
   * 仅反馈不阻断；
   * 立即终止任务。
6. 向 worker 注入结构化修复反馈。
7. 禁止 worker 在未处理 failure 前报告 completed。

---

# 5. Failure Policy 分级

不是所有 validator 失败都应该同样处理。建议按失败类型分策略。

| 失败类型                      | 推荐策略             | 原因              |
| ------------------------- | ---------------- | --------------- |
| Path policy violation     | 立即回滚并终止或 blocked | 安全边界不可修修补补      |
| Forbidden glob write      | 立即回滚并终止或 blocked | 违反 contract     |
| Syntax error              | 保留一次或回滚带 diff    | 通常容易修           |
| TypeScript type error     | 保留在 worktree 中修复 | 最适合原地修          |
| Lint warning              | feedback only    | 不应阻塞核心功能        |
| Lint error                | 可修复，不立即回滚        | 多数可自动改正         |
| Unit test failed          | 保留在 worktree 中修复 | 测试失败需要上下文       |
| Integration test failed   | 保留事务并限制次数        | 可能涉及多文件         |
| Build failed              | 保留事务修复           | 需要完整 diff       |
| Dependency install failed | blocked 或人工确认    | 通常不是代码 patch 问题 |
| Runtime crash             | 视严重程度修复或 blocked | 需要错误日志          |

---

# 6. Repair Loop 设计

## 6.1 Repair Budget

每个事务需要 repair budget，避免 worker 无限修。

建议默认：

| 维度                  |       默认值 |
| ------------------- | --------: |
| 每个文件最大修复次数          |         2 |
| 每个任务最大修复次数          |         4 |
| 同一错误签名最大重复次数        |         2 |
| 全局 repair loop 最大轮数 | 由 W3.5 控制 |

错误签名可以由以下信息组成：

* checker type；
* 文件路径；
* 错误码；
* 错误消息摘要；
* 行列范围。

如果同一错误签名反复出现，说明 worker 没有收敛，应停止当前任务并交给 W3.5 回环。

---

## 6.2 Repair Feedback 给 worker 的内容

validator 失败后，反馈不能只是“验证失败”。应该包含：

| 内容                   | 作用                             |
| -------------------- | ------------------------------ |
| 当前任务目标               | 防止 worker 偏离原任务                |
| acceptance criteria  | 提醒它修复目标                        |
| 失败类型                 | syntax/type/test/build         |
| diagnostics 摘要       | 指出哪里错                          |
| failed diff          | 告诉它上次改了什么                      |
| touched files        | 告诉它影响范围                        |
| repair budget        | 告诉它还剩几次                        |
| allowed next actions | 只能继续修复、报告 blocked、报告 failed    |
| 禁止事项                 | 不得扩大范围，不得绕过测试，不得忽略错误 completed |

反馈应该强制 worker 做三选一：

1. 修复当前 validation failure；
2. 明确报告 blocked，并说明缺少什么；
3. 明确报告 failed，并附失败证据。

不允许第四种：直接 completed。

---

## 6.3 Pending Repair Finish Gate

这是必须加的。

当 worker 没有继续调用工具，准备输出最终 `<task_report>` 时，系统检查 transaction：

| 条件                                        | 行为                          |
| ----------------------------------------- | --------------------------- |
| 没有 pending failure                        | 允许 completed                |
| 有 pending failure，但 report 是 completed    | 拦截，要求继续修复或改成 blocked/failed |
| 有 pending failure，report 是 blocked/failed | 允许结束                        |
| repair budget 已耗尽                         | 强制 failed 或 blocked         |
| validator 未运行过                            | 根据 contract 决定是否强制验证        |

这能防止 worker 忽略 validator 错误。

---

# 7. 多文件一致性设计

## 7.1 touchedFiles 的来源

`touchedFiles` 不应该只来自 tool 参数。应综合：

1. 写工具参数；
2. apply patch 实际影响文件；
3. git diff / filesystem diff；
4. validator 报告中的 affected files；
5. 新增/删除/重命名文件记录。

这样才能处理多文件 patch。

---

## 7.2 多文件 rollback

事务失败时不要只回滚最后一个文件，而是回滚整个事务 touched set。

回滚策略：

| 文件类型      | 回滚行为                  |
| --------- | --------------------- |
| 修改过的已有文件  | 恢复到 pre-edit snapshot |
| 新增文件      | 删除                    |
| 删除文件      | 恢复原内容                 |
| 重命名文件     | 还原旧路径                 |
| 多文件 patch | 作为一个事务整体回滚            |

这比单文件 restore 稳定很多。

---

## 7.3 多文件 validation

有些验证必须跨文件运行，例如：

* TypeScript project compile；
* unit test；
* build；
* import graph；
* package config consistency；
* route registration；
* API schema compatibility。

这类验证结果应该绑定到整个 transaction，而不是某个单独文件。

---

# 8. 与 worktree isolation 的关系

方案三强烈建议和 worktree isolation 绑定。

## worktree 模式下

推荐策略：

| 行为               | 策略                 |
| ---------------- | ------------------ |
| validator failed | 保留失败修改             |
| worker repair    | 在 worktree 中原地修    |
| repair passed    | commit worktree 变更 |
| repair exhausted | 丢弃 worktree        |
| apply to main    | 只在 validated 后执行   |

这样坏代码只存在临时 worktree，不污染主项目。

## 非 worktree 模式下

推荐策略更保守：

| 行为               | 策略                          |
| ---------------- | --------------------------- |
| validator failed | 捕获 failed diff 后回滚          |
| worker repair    | 基于 failed diff 重新生成 patch   |
| repair exhausted | 保持主工作区 clean                |
| 多文件事务            | 需要 snapshot manager 支持全事务回滚 |

也就是说：

> 有 worktree 就原地修；没有 worktree 就 rollback-with-diff。

---

# 9. 与 TaskRunner 的关系

当前 `TaskRunner` 主要根据 `<task_report>` 解析任务状态：blocked、degraded、skipped、failed/error，其他有 report 的情况视为 ok。这个逻辑需要补一个事务闸门。

## 需要新增的判断

TaskRunner 在接受 worker 输出前，应读取 transaction status：

| transaction 状态                | worker report | TaskRunner 结果  |
| ----------------------------- | ------------- | -------------- |
| validated                     | completed     | ok             |
| validation_failed / repairing | completed     | 拦截，不允许 ok      |
| validation_failed / repairing | blocked       | blocked        |
| validation_failed / repairing | failed        | error 或 failed |
| repair_exhausted              | completed     | error          |
| rolled_back                   | completed     | error          |
| committed                     | completed     | ok             |

核心原则：

> `<task_report>` 不能覆盖 transaction 的事实状态。

---

# 10. 与 W3.5 mission_checker 的关系

W3.5 不负责微观修复，它负责全局验收。

方案三落地后，W3.5 输入应增加事务证据：

| 证据                       | 作用             |
| ------------------------ | -------------- |
| task transaction summary | 每个 task 的最终状态  |
| touched files            | 实际变更范围         |
| validation failures      | 中途失败及修复过程      |
| final validation result  | 最终是否通过         |
| repair attempts          | 是否高风险反复修       |
| rollback records         | 哪些修改被丢弃        |
| test evidence            | 测试命令、结果、覆盖范围   |
| unresolved failures      | 是否需要 loop back |

W3.5 可以据此更准确判断：

* 是不是可以进入 W4；
* 是不是需要回 W1；
* 是不是需要人工确认；
* 是不是测试证据不足；
* 是不是修复次数过多，说明设计有问题。

---

# 11. Artifact 设计

每个 task transaction 应输出一个结构化 artifact。

建议包含两类：

## 11.1 人类可读报告

用于调试和审查：

| Section             | 内容                                 |
| ------------------- | ---------------------------------- |
| Task Overview       | taskId、persona、objective           |
| Contract Summary    | acceptance、allowed globs、non-goals |
| Changed Files       | 新增、修改、删除文件                         |
| Validation Timeline | 每次验证运行和结果                          |
| Repair Timeline     | 每次失败、修复、再次验证                       |
| Final Result        | completed / blocked / failed       |
| Risk Notes          | 未解决风险和测试缺口                         |

## 11.2 机器可读记录

用于 pipeline 判断：

| 字段                 | 内容                   |
| ------------------ | -------------------- |
| transactionId      | 事务 ID                |
| taskId             | 任务 ID                |
| status             | 最终状态                 |
| touchedFiles       | 文件列表                 |
| validatorsRun      | validator 列表         |
| failures           | 失败记录                 |
| repairAttempts     | 修复次数                 |
| unresolvedFailures | 未解决问题                |
| finalEvidence      | 最终验证证据               |
| applyCommit        | 如果使用 git，记录最终 commit |
| rollbackReason     | 如果回滚，记录原因            |

---

# 12. 事件体系

为了 UI 和日志清晰，建议拆分事件。

| 事件                         | 触发时机                |
| -------------------------- | ------------------- |
| `transaction_started`      | task transaction 创建 |
| `transaction_file_touched` | 文件被修改               |
| `validation_started`       | validator 开始        |
| `validation_passed`        | validator 通过        |
| `validation_failed`        | validator 失败        |
| `repair_feedback_injected` | 给 worker 注入修复反馈     |
| `repair_attempt_started`   | worker 开始第 N 次修复    |
| `repair_attempt_passed`    | 修复后验证通过             |
| `repair_attempt_failed`    | 修复后仍失败              |
| `repair_budget_exhausted`  | 修复次数耗尽              |
| `transaction_validated`    | 事务整体验证通过            |
| `transaction_committed`    | 变更应用回主工作区           |
| `transaction_rolled_back`  | 事务整体回滚              |
| `transaction_blocked`      | worker 标记 blocked   |
| `transaction_failed`       | 事务失败结束              |

不要只靠 `tool_rolled_back` 一个事件表达全部状态。

---

# 13. 配置建议

建议新增一个独立配置区：

| 配置项                                                |              推荐默认值 | 说明                              |
| -------------------------------------------------- | -----------------: | ------------------------------- |
| transaction.enabled                                |               true | 是否启用任务事务                        |
| transaction.mode                                   | worktree_preferred | 优先使用 worktree                   |
| validationRepair.enabled                           |               true | 是否启用修复循环                        |
| validationRepair.maxAttemptsPerFile                |                  2 | 单文件最大修复次数                       |
| validationRepair.maxAttemptsPerTask                |                  4 | 单任务最大修复次数                       |
| validationRepair.includeFailedDiff                 |               true | 是否反馈 failed diff                |
| validationRepair.retainFailedEditInWorktree        |               true | worktree 下保留失败修改                |
| validationRepair.rollbackOnExhausted               |               true | 修复耗尽后回滚                         |
| validationRepair.blockCompletedWithPendingFailures |               true | 有 pending failure 时禁止 completed |
| validationRepair.maxDiffChars                      |              20000 | failed diff 最大长度                |
| validationRepair.maxDiagnosticChars                |              12000 | diagnostics 最大长度                |
| validationRepair.sameErrorRepeatLimit              |                  2 | 同错误反复出现上限                       |

推荐默认策略：

| 环境                      | 策略                        |
| ----------------------- | ------------------------- |
| worktreeIsolation=true  | retain failed edit，允许原地修  |
| worktreeIsolation=false | rollback with failed diff |
| CI / strict mode        | repair 次数少，失败快            |
| local dev mode          | repair 次数可稍多              |

---

# 14. 分阶段落地计划

## Phase 1：事务记录，不改变行为

目标：先建立 transaction artifact 和状态记录。

改动：

* task 启动时创建 transaction；
* 记录 touched files；
* 记录 validation result；
* 记录 rollback；
* 输出 transaction summary。

行为仍然可以保持“失败即回滚”。

验收标准：

* 每个 task 都有 transaction summary；
* 能看到 touched files；
* 能看到 validation failure；
* 不影响现有 pipeline。

---

## Phase 2：failed diff 反馈

目标：增强当前 rollback 模式。

改动：

* validator failed 时捕获 failed diff；
* restore 前保存 diff；
* tool result 中包含 diagnostics + failed diff；
* transaction artifact 中记录 failed diff 摘要。

验收标准：

* worker 看到上一次失败修改；
* 主工作区仍然保持 clean；
* 单文件错误修复成功率提升。

---

## Phase 3：worktree 内原地修复

目标：让 worker 在隔离 worktree 中修复失败代码。

改动：

* worktree 模式下 validator failed 不立即 restore；
* 标记 pending repair；
* 注入修复反馈；
* 允许 worker 再次 edit；
* 修复通过后清除 failure；
* 修复耗尽后丢弃 worktree。

验收标准：

* 坏代码不会进入主工作区；
* worker 能基于失败文件继续 patch；
* pending failure 时不能 completed。

---

## Phase 4：任务完成闸门

目标：防止 worker 自报 completed 绕过验证。

改动：

* TaskRunner 接入 transaction status；
* completed 之前检查 unresolved failures；
* 有 unresolved failures 时自动拦截；
* 允许 blocked/failed 带证据结束。

验收标准：

* pending validation failure 下 completed 不会被视为 ok；
* blocked/failed 可以正常进入 W3.5；
* W3.5 可以看到失败证据。

---

## Phase 5：多文件事务回滚

目标：支持复杂 patch 和集成任务。

改动：

* touched files 从实际 diff 中识别；
* snapshot 覆盖所有 touched files；
* 新增/删除/重命名都能回滚；
* task transaction 统一 rollback。

验收标准：

* 多文件 patch 失败后可以完整回滚；
* 不出现半回滚状态；
* deleted/new file 都处理正确。

---

## Phase 6：W3.5 证据增强

目标：让全局验收更可靠。

改动：

* mission checker 输入增加 transaction summaries；
* W3.5 判断 test adequacy 时引用最终验证证据；
* repair attempts 过多时标记风险；
* unresolved failure 自动触发 LOOP_BACK 或 human confirmation。

验收标准：

* W3.5 报告能列出验证证据；
* 不会只因为 worker 自报 completed 就进入 W4；
* 失败任务能转成更小的 loop-back tasks。

---

# 15. 验收标准

方案三完成后，应满足这些验收项：

## 功能验收

* worker 写坏代码后，可以在 worktree 中继续修复。
* worker 能看到 failed diff 和 diagnostics。
* 多文件 patch 失败后能整体回滚。
* 有 unresolved validation failure 时，worker 不能 completed。
* 修复通过后，事务才能进入 validated。
* validated 后才允许 apply 回主工作区。
* 修复耗尽后，事务进入 failed / blocked，并保留证据。

## 安全验收

* forbidden glob 写入仍然立即阻断。
* path policy violation 不进入 repair loop。
* 主工作区不会出现未验证的失败修改。
* worktree discard 后无残留。
* 非 worktree 模式下仍保持 rollback-first 策略。

## Pipeline 验收

* TaskRunner 不再只依赖 `<task_report>`。
* W3.5 可以读取事务证据。
* repair loop 不会无限循环。
* W4 不会接收 unresolved transaction。
* delivery report 能说明哪些文件改了、哪些验证跑了、哪些风险仍在。

---

# 16. 风险与规避

| 风险                | 说明                     | 规避                                       |
| ----------------- | ---------------------- | ---------------------------------------- |
| repair loop 变慢    | worker 多修几次会增加耗时       | 设置 repair budget                         |
| diff 太大           | 大重构 failed diff 可能过长   | diff 摘要 + 文件列表 + 截断                      |
| worker 反复修同一错误    | 可能陷入循环                 | same-error repeat limit                  |
| 多文件 rollback 复杂   | 新增/删除/重命名要处理           | 事务级 touched file registry                |
| worktree apply 冲突 | 主树可能变化                 | validated 后三方 merge / conflict blocked   |
| validator 误报      | 错误 validator 会阻塞任务     | 支持 human confirmation / policy downgrade |
| completed 被错误拦截   | warning 类 failure 不应阻塞 | 区分 blocking 和 non-blocking validator     |

---

# 17. 最终推荐形态

最终系统应该变成：

```text id="f6r0cd"
Task starts
  ↓
Create transaction + worktree
  ↓
Worker edits files
  ↓
Transaction records touched files
  ↓
Validator runs
  ↓
If failed:
    retain failed edit in worktree
    feed diagnostics + failed diff
    force repair or blocked/failed
  ↓
If repaired:
    clear pending failure
    continue
  ↓
Before completed:
    transaction gate checks unresolved failures
  ↓
If validated:
    commit/apply transaction
  ↓
W3.5 checks transaction evidence
  ↓
APPROVED_TO_W4 or LOOP_BACK_TO_W1
```

---

## 最关键的一条原则

> **不要让 validator failure 直接终结 worker，也不要让 failed edit 直接污染主工作区。失败修改应该被保存在 task transaction 里，作为 worker 自我修复的上下文；最终只有通过验证的 transaction 才能交付。**
