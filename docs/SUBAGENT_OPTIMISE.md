# Dynamic Ready Queue Harness 方案

## 1. 核心目标

Dynamic Ready Queue 的目标是让 subagent **按 DAG 依赖实时解锁执行**，而不是按固定 wave barrier 等整批任务结束。

旧的 wave 模型是：

```text
Wave 0 全部完成
  → Wave 1 全部启动
    → Wave 2 全部启动
```

Dynamic Ready Queue 是：

```text
某个上游任务一完成
  → 立即检查它的下游任务
  → 只要依赖满足、资源可用、写锁不冲突
  → 立刻触发对应 subagent
```

它适合更大规模的 pipeline，因为不会被同一 wave 里的慢任务拖住。

---

# 2. 总体架构

建议把 harness 独立成一个运行时层：

```text
master_planner
  → 生成 DAG / TaskContract

DagHarness
  → 负责动态调度、依赖解锁、资源控制、失败传播

WorkerRuntime
  → 执行单个 subagent

PolicyLayer
  → 工具权限、路径权限、审批、rollback、validator

MissionChecker
  → W3.5 验收与回环修复

Finalizer
  → W4 memory governance + final_brief
```

关键原则：

```text
master_planner 只产出任务图
harness 负责执行任务图
worker 只执行自己的 TaskContract
mission_checker 负责验收和回环
```

不要让 master_planner 直接“手动调用 subagent”。这样系统边界会更干净。

---

# 3. Harness 内部核心组件

## 3.1 Task Graph Index

启动时把所有 `TaskContract` 编译成运行时图索引：

```text
taskId → task
taskId → upstream deps
taskId → downstream dependents
taskId → unresolved dependency count
taskId → runtime status
```

它负责回答：

```text
谁依赖我？
我还缺哪些上游？
我的所有硬依赖是否已完成？
```

---

## 3.2 Ready Queue

Ready Queue 保存已经满足依赖、等待调度的任务。

任务进入 Ready Queue 的条件：

```text
1. 所有 hard dependsOn 已 ok
2. launchRequirements 已满足
3. TaskContract 校验通过
4. 没有被上游失败强制 skip
5. 没有等待人工确认
```

Ready Queue 不等于立刻执行。进入 Ready Queue 后，还要经过资源调度。

---

## 3.3 Running Set

记录当前正在运行的任务：

```text
running task id
persona id
allowedGlobs
startedAt
current tool
approval pending 状态
resource locks
```

用途：

```text
1. 控制并发
2. 检查写冲突
3. TUI 展示活跃 subagent
4. 支持取消 / 超时 / 失败恢复
```

---

## 3.4 Result Store

保存每个任务的最终结果：

```text
taskId
personaId
status: ok / blocked / failed / contract_invalid / skipped
task_report
memory_candidate
artifacts
written files
errors
duration
usage
```

它也是 launch gate 的 evidence source。

比如下游任务要求：

```text
T0-1.file_list
T0-2.static_compile_commands
T1-1.test_commands
```

harness 就从 Result Store 里查。

---

## 3.5 Artifact Index

从 task_report 里抽取结构化 artifact：

```text
file_list
relevant_files
tech_stack
test_commands
static_compile_commands
visual_summary
dependency_manifest
install_report
validation_report
```

不要让下游直接解析上游完整报告。
harness 应该维护一个 normalized artifact index，方便 launch gate 判断。

---

## 3.6 Resource Manager

负责全局资源控制：

```text
global max active subagents
per-persona max concurrency
write lock
approval slot
shell / install_dependency slot
model rate limit
```

建议至少有这些限制：

| 资源                  | 作用                |
| ------------------- | ----------------- |
| global concurrency  | 防止一次性启动太多 worker  |
| persona concurrency | 防止同类 persona 过载   |
| write locks         | 防止并发写同一文件         |
| shell/install slots | 防止多个安装/测试命令同时污染环境 |
| approval queue      | 防止 TUI 同时弹多个审批    |

---

# 4. 任务状态机

每个 task 建议使用明确状态：

```text
pending
  还没满足依赖

ready
  依赖满足，等待资源

scheduled
  已拿到资源，准备启动

running
  subagent 执行中

approval_waiting
  工具调用等待用户审批

ok
  成功完成

blocked
  因缺上下文、缺 artifact、权限不足、用户拒绝等阻塞

failed
  执行失败

contract_invalid
  TaskContract 无效

skipped
  上游失败导致不会执行

deferred
  暂时不能执行，等待 repair 或人工确认
```

状态转移大致是：

```text
pending
  → ready
  → scheduled
  → running
  → ok

running
  → approval_waiting
  → running

running
  → blocked / failed / contract_invalid

pending / ready
  → skipped
```

---

# 5. 动态调度主流程

## 5.1 初始化

harness 启动时：

```text
1. 校验所有 TaskContract
2. 检测 DAG cycle
3. 建立 upstream/downstream 索引
4. 初始化每个 task 状态为 pending
5. 找出无硬依赖任务
6. 对这些任务跑 launch gate
7. 满足条件的放入 Ready Queue
```

如果初始化时发现：

```text
cycle
duplicate taskId
unknown persona
dangling dependency
parallel write conflict 明显不可解
```

应该直接让 pipeline 停在 human confirmation 或 compile/refine retry，而不是进入执行。

---

## 5.2 Ready Evaluation

一个任务进入 ready 前，要检查：

```text
Dependency Gate:
  dependsOn 是否全部 ok

Launch Gate:
  launchRequirements 是否满足

Contract Gate:
  allowedGlobs / acceptance / blockedCondition 是否完整

Policy Gate:
  persona 是否允许该工具面
  写任务是否有可写路径

Artifact Gate:
  上游 artifact 是否可解析、非空、状态 ok

Human Gate:
  是否有之前用户要求暂停/确认
```

如果失败，分三类处理：

| 类型           | 处理                                |
| ------------ | --------------------------------- |
| 永久失败         | 标记 `contract_invalid` 或 `skipped` |
| 暂时缺 evidence | 标记 `deferred`                     |
| 可尝试上下文重跑     | 进入 retry / W3.5 repair            |

---

## 5.3 Resource Scheduling

Ready Queue 里的任务不直接启动。要先申请资源：

```text
1. persona 并发槽
2. 全局 subagent 槽
3. 写锁
4. shell/install 槽
5. approval 队列可用性
```

只有全部资源可用，任务才从 `ready` 变成 `scheduled/running`。

如果资源不可用：

```text
保留在 Ready Queue
等待下一次资源释放事件
```

---

## 5.4 Worker Launch

任务启动后：

```text
1. 构造 worker system prompt
2. 注入 TaskContract
3. 注入 ContextPack
4. 暴露 persona allowlist + granted tools
5. WorkerLoop 开始执行
6. 工具调用经过 approval / path policy / validator
7. 产生 task_report
```

harness 不应该参与 worker 内部推理，只处理：

```text
worker event
tool event
approval event
usage event
final result
```

---

## 5.5 Completion Handling

当某个 task 完成：

```text
1. 释放 persona slot
2. 释放 write lock
3. 释放 shell/install slot
4. 解析 task_report
5. 写入 Result Store
6. 更新 Artifact Index
7. 找出 downstream tasks
8. 重新评估 downstream readiness
9. 新 ready 的任务进入 Ready Queue
10. 继续调度
```

这就是动态解锁的核心。

---

# 6. 调度策略

Ready Queue 可以有多个策略，建议先从稳定策略开始。

## 6.1 基础策略：Stable FIFO

排序规则：

```text
1. priority 高的先执行
2. dependency depth 小的先执行
3. taskId 字典序稳定排序
4. 同 persona 避免连续占满
```

优点：

```text
确定性强
日志容易复现
单测容易写
```

---

## 6.2 工程优化策略：Critical Path First

如果要提升吞吐，可以优先执行“阻塞最多下游”的任务：

```text
downstream count 越大
critical path 越长
越优先
```

适合大型 DAG：

```text
repo_scout / context_builder / test_runner 这类解锁很多下游的任务优先
```

---

## 6.3 Fairness 策略

避免某类 persona 长时间霸占资源：

```text
code_executor 不应压死 test_runner
test_runner 不应压死 reviewer
web_searcher 不应压死 repo_scout
```

可以做 persona round-robin：

```text
每轮从不同 persona 的 ready bucket 里取任务
```

---

# 7. 依赖语义设计

## 7.1 Hard Dependency

最普通的 `dependsOn`：

```text
T2 dependsOn T1
```

含义：

```text
T1 必须 ok
T2 才能启动
```

如果 T1 failed，则 T2 默认 skipped。

---

## 7.2 Soft / Optional Dependency

由 `launchRequirements.required = false` 表达。

含义：

```text
有这个 artifact 更好
没有也可以启动
```

适合：

```text
optional docs summary
non-blocking visual reference
extra web_searcher context
```

---

## 7.3 Artifact Dependency

更精细的依赖，不只是 task 完成，而是要求它产出某个 artifact：

```text
T2 requires T0-1.file_list
T3 requires T2-1.install_report
T4 requires T3-1.validation_report
```

它比 dependsOn 更强：

```text
dependsOn 只看状态 ok
artifact dependency 还要看报告里是否有指定结构化产物
```

建议以后把 `launchRequirements` 作为主要 gate，而不是只靠 `dependsOn`。

---

## 7.4 Failure Dependency

某些任务只在上游失败时启动：

```text
runtime_debug 依赖 test_runner failed
```

这不是普通 success dependency。

建议设计一种条件依赖：

```text
triggerOn:
  upstream: T3-1
  status: failed
```

用途：

```text
test_runner failed
  → runtime_debug 启动分析失败原因
  → code_executor repair
```

第一版可以先不实现，交给 W3.5 repair DAG；后续再加入。

---

# 8. 写锁设计

Dynamic Queue 必须重点处理写冲突。

## 8.1 写锁来源

写锁来自 TaskContract：

```text
allowedGlobs
```

每个 write-capable task 启动前申请写锁。

如果两个任务可能写同一文件：

```text
不能并发
后一个留在 Ready Queue
```

---

## 8.2 保守匹配

不要追求完美 glob 判交。第一版用保守规则：

```text
同一个精确文件路径冲突
父子目录冲突
通配符覆盖范围冲突
未知范围冲突
```

比如：

```text
src/**
src/api/upload.ts
```

视为冲突。

```text
src/api/**
src/components/**
```

可以并发。

---

## 8.3 install_dependency 特殊锁

依赖安装应单独加环境锁：

```text
dependency install lock
```

即使两个任务改不同包，也不建议并发安装，因为会同时改 lockfile、node_modules、venv。

规则：

```text
同一 projectRoot 下 install_dependency 一次只能跑一个
```

---

## 8.4 shell/test 锁

`test_runner` 跑命令也要小心。建议：

```text
read-only validation command 可以并发，但默认限制 1~2 个
install/build/migration 命令必须串行
```

否则容易出现：

```text
两个测试命令同时抢 node_modules
一个任务安装依赖时另一个任务跑 typecheck
```

---

# 9. Blocked / Failed 处理策略

## 9.1 blocked

`blocked` 表示任务本身没有完成，但不一定是 bug。

常见原因：

```text
缺少上游 artifact
上下文不足
用户拒绝审批
路径权限不足
依赖安装被拒绝
```

处理策略：

```text
1. 如果是缺上下文，允许 same-contract retry 一次
2. 如果是权限/审批拒绝，标记 human_confirmation 或 deferred
3. 如果是 TaskContract 太宽/太窄，交给 W3.5 生成 repair task
```

---

## 9.2 failed

`failed` 表示 worker 执行失败或验证失败。

处理策略：

```text
1. 停止强依赖下游
2. 解锁 failure-debug 任务，如果 DAG 中有
3. 没有 failure-debug 任务则交给 W3.5
4. W3.5 决定 loop-back 或 human confirmation
```

---

## 9.3 skipped

如果上游 hard dependency failed，下游不应该假装执行：

```text
T1 failed
T2 dependsOn T1
T2 skipped: upstream failed
```

这比让 T2 blocked 更清楚。

---

# 10. Retry 设计

Dynamic Queue 中 retry 不应无限发生。

建议分三层：

## 10.1 Schema Retry

worker 没有输出合法 `<task_report>`：

```text
TaskRunner 自动 schema repair 一次
```

这是局部修复，不进入 DAG 层。

---

## 10.2 Same-contract Retry

任务因为临时缺上下文 blocked：

```text
同一个 TaskContract 重试一次
```

适合：

```text
worker 第一次没读到 artifact
上下文包引用遗漏
tool result 截断导致误判
```

---

## 10.3 Repair DAG Retry

如果问题需要改变任务上下文、owner、allowedGlobs、acceptance：

```text
交给 W3.5 生成 repair DAG
```

这不是重试旧 task，而是创建新 task。

---

# 11. Dynamic Queue 和 W3.5 的关系

Dynamic Queue 负责执行 DAG，不负责判断“整体任务是否完成”。

当所有可执行任务进入终态后：

```text
ok / failed / blocked / skipped / deferred
```

harness 把完整结果交给 W3.5：

```text
W3.5 mission_checker
  → APPROVED_TO_W4
  → LOOP_BACK_TO_W1
  → NEEDS_HUMAN_CONFIRMATION
```

如果 W3.5 生成 repair DAG：

```text
repair DAG
  → 重新进入 Dynamic Queue
  → 和已有 Result Store 合并
  → 继续动态调度
```

也就是：

```text
Dynamic Queue 是执行器
W3.5 是验收器
```

不要让 Dynamic Queue 自己决定业务验收通过。

---

# 12. TUI 展示设计

Dynamic Queue 比 wave 更动态，TUI 要从“第几波”改成“任务流状态”。

建议展示三层：

## 12.1 Pipeline Header

```text
PIPELINE · Build · running · 7/13 done · 3 active · 2 ready · 1 blocked
```

---

## 12.2 Active Subagents

```text
RUNNING
T2-1 code_executor   step 4/20  edit_file src/api/upload.ts
T3-1 test_runner     step 2/10  exec_shell npm run typecheck
T4-1 docs            step 1/8   write_file docs/upload.md
```

---

## 12.3 Queue / Blocked Summary

```text
READY
T2-2 code_executor   waiting: write lock src/api/**
T3-2 reviewer        waiting: dependency T2-1

BLOCKED
T5-1 test_runner     missing T0-1.static_compile_commands
```

这样用户能看懂：

```text
谁在跑
谁准备跑
谁被依赖/资源/审批卡住
```

---

# 13. Event 设计

Dynamic Queue 应该输出事件流，而不是只返回最终结果。

建议事件类型：

```text
harness_start
task_ready
task_scheduled
task_started
task_progress
task_approval_waiting
task_done
task_blocked
task_failed
task_skipped
resource_wait
write_lock_wait
dependency_unlocked
queue_idle
harness_complete
```

这些事件给 TUI、日志、debug 都很有用。

---

# 14. Idle Detection

Dynamic Queue 必须检测“没有任务在跑，也没有任务 ready，但 DAG 没完成”的情况。

这通常表示：

```text
1. 有任务 deferred
2. 有任务等待人工确认
3. launchRequirements 永远不满足
4. 上游失败传播没有处理干净
5. 资源锁泄漏
```

此时不能死等。应该进入：

```text
queue_idle
  → 生成诊断
  → 交给 W3.5 或 human confirmation
```

Idle diagnostic 应该列出：

```text
pending tasks
每个 pending task 缺什么依赖
deferred tasks
blocked tasks
running count
ready count
held locks
```

---

# 15. Determinism 设计

动态调度容易变得不可复现。建议保留确定性：

```text
1. Ready Queue 稳定排序
2. 相同 priority 下按 taskId 排
3. 锁竞争失败不改变原始顺序
4. 每次调度决策写入 trace log
5. 任务启动原因可追踪
```

每个任务都应该能回答：

```text
为什么现在启动？
为什么没启动？
等的是哪个依赖/资源/审批？
```

---

# 16. 与现有 WaveScheduler 的迁移方式

建议不要一次性替换。

## 阶段 1：抽象 Harness 接口

保留原 wave 行为，但把它包成统一接口：

```text
DagHarness
  mode: wave
```

外部只知道：

```text
harness.run(contracts)
```

---

## 阶段 2：增加 Dynamic 模式

新增：

```text
DagHarness
  mode: dynamic
```

先只用于 W2/3 Build，不动 W1/W0.5/W3.5/W4。

---

## 阶段 3：扩大到 repair DAG

让 W3.5 生成的 repair DAG 也走 dynamic harness。

---

## 阶段 4：统一所有 task pass

最终：

```text
W1 perception
W2/3 build
W3.5 repair
```

都可以走同一个 Dynamic Queue，只是阶段标签不同。

---

# 17. 推荐默认策略

第一版 Dynamic Ready Queue 建议这样定：

```text
Scheduling:
  priority + stable FIFO

Concurrency:
  global max active = 4
  code_executor max = 2
  repo_scout max = 2
  test_runner max = 1 or 2
  reviewer max = 1
  docs max = 1

Locks:
  write lock required for write-capable tasks
  install_dependency global project lock
  shell command limited concurrency

Failure:
  hard dependency failed → downstream skipped
  blocked context gap → same-contract retry once
  unresolved blocked/failed → W3.5

TUI:
  show running / ready / blocked / waiting resources
```

---

# 18. 最终形态

最终 harness 应该像一个小型 CI 调度器：

```text
1. 读取 DAG
2. 校验合约
3. 实时解锁 ready tasks
4. 按资源和写锁调度 subagent
5. 收集结果和 artifacts
6. 传播失败和 blocked 状态
7. 空转时输出诊断
8. 完成后交给 W3.5 验收
```

核心价值是：

```text
不是“按顺序跑 agent”
而是“按依赖、证据、权限、资源实时调度 agent”
```

这样你的 pipeline 会从：

```text
阶段式多 agent
```

升级成：

```text
DAG 驱动的 subagent runtime
```
