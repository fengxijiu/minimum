# 方案：统一双调度 / 双 LaunchGate（#7）

> 状态：**已完整实现**。harness 成为唯一 launch-gate 权威，wave 层 `applyLaunchGate` / `retryBlockedContextGaps` / `readonlyFallbackIssues` 已删除。本文件只覆盖 #7（双系统割裂），不含 #1/#2/#3/#4/#6/#8/#9/#10 的修复（已单独处理）。

## 关键发现 — wave 与 harness 语义相反（已在迁入时调和）

实现时发现 wave 层与 harness 的 launch gate **不是简单重复，而是语义相反**：

- **harness（旧·严格）**：requirement 未满足 → **立即 defer**。
- **wave 层（宽松）**：cross-phase requirement 未满足 → **先放行跑一次**（`gate_retry`），跑回 `blocked` 才 defer（`mimo-pipeline.test.ts` L187/226）。喂给 W3.5 修复环的刻意行为。

**调和方案（已落地）**：把宽松语义迁进 harness，按「源位置」区分：

- **cross-phase gap**（源只在 `priorResults`，不在本 invocation graph）→ 一次宽松运行（`gate_retry`），再 `blocked` 才 defer。
- **intra gap**（源在本 graph）→ 严格 defer（保留 harness F1 行为）。
- **context-gap blocked**（gate 过了但运行时报 blocked）→ 一次重跑，共用同一 per-task 预算（取代 `retryBlockedContextGaps`）。
- **readonly fallback**（degraded 上游）→ gate 通过并 emit `gate_fallback`（取代 `readonlyFallbackIssues`）。
- `static_compile` gap → 严格 defer。

harness 新增事件 `gate_retry` / `task_deferred` / `gate_fallback`，由 `runWaves` 映射成对应 PipelineEvent + `knownIssues`；`MiMoPipeline` 把 W1 结果作为 `priorResults` 注入 W2/3 的 `runWaves`，不再调用任何 wave 层 gate 函数。

## 1. 问题陈述

当前一次 DAG 执行存在 **两套独立的就绪/门控/降级逻辑**，数据源不同、deferred 概念不互通、优先级口径不一致：

| 维度 | Wave 层（`MiMoPipeline`） | Dynamic 层（`DynamicHarness`） |
|---|---|---|
| LaunchGate | `applyLaunchGate`（`MiMoPipeline.ts:1142`） | `promote` → `evaluateLaunchGate`（`DynamicHarness.ts:83`） |
| 数据源 | 全量跨阶段 `allResults` | 仅本次 invocation 的 `results.getAll()` |
| defer 概念 | `deferred: Set<string>` + `knownIssues` | `graph.markDeferred` + `blockedByDeferred` |
| 优先级 | `ReadyQueue.priorityWeight`（`(c as any).priority`） | `TaskGraphIndex.comparePriority`（unresolvedCount + downstream size） |
| 跨阶段 requirement | 由 wave 层负责 | `promote` 用 `intraReqs` **静默跳过** |

**核心风险**：`promote` 注释明确写着「跨阶段 requirement 是 caller 的责任」。一旦上层忘记预先 `applyLaunchGate`，跨阶段依赖会被**盲启动**。两套 defer 不互通，意味着 wave 层 defer 的任务进入 harness 后状态丢失，靠 `knownIssues` 字符串对账。

## 2. 目标

1. **单一 LaunchGate 权威**：所有就绪判定走同一段 `evaluateLaunchGate`，喂同一份 artifact / result 视图。
2. **单一 defer 状态**：消除 wave 层 `deferred:Set` 与 graph `blockedByDeferred` 的双写。
3. **单一优先级口径**：`ReadyQueue` 与 `TaskGraphIndex` 用同一个比较器；删除 `(c as any).priority` 的类型逃逸。
4. **跨阶段 artifact 显式注入**，而非靠 `intraReqs` 静默丢弃。

## 3. 方案

### 3.1 引入 `ResultView` 抽象（跨阶段结果只读视图）

新增一个只读接口，让 harness 的 LaunchGate 能看到**本次 invocation 之外**的上游结果（W1 感知产物），而不是只看 `results.getAll()`：

```ts
export interface ResultView {
  get(taskId: string): TaskResult | undefined;
  artifactsFor(taskId: string): Map<LaunchArtifact, string> | undefined;
}
```

- `DagHarnessOptions` 增加可选 `priorResults?: ResultView`。
- `DynamicHarness.promote` 评估门控时，合并 `priorResults` + 本次 `results`，**删除 `intraReqs` 过滤**——跨阶段 requirement 不再被静默跳过，而是真正参与门控。
- `MiMoPipeline.runWaves` 把 `allResults`（含 W1 感知）包成 `ResultView` 传入，于是 wave 层**不再需要**自己跑 `applyLaunchGate`。

### 3.2 退役 wave 层 `applyLaunchGate`（✅ 已实现）

`MiMoPipeline.applyLaunchGate` / `retryBlockedContextGaps` / `readonlyFallbackIssues` 已删除，逻辑迁进 harness：

- harness 给 cross-phase requirement 一个 per-task 预算（`gateRetryUsed`）：gate 失败时**先放行一次**并 emit `gate_retry`，跑回 `blocked` 才 defer —— 复刻 wave 层宽松语义；intra gap 仍严格 defer。
- `handleTaskComplete` 的 `blocked` 分支：context-gap 时一次重跑（共用同一预算），否则 emit `task_deferred` 并 markDeferred。
- `promote` 过 gate 时检测 readonly fallback，emit `gate_fallback`。
- `runWaves` 订阅 harness 的 `gate_retry`/`task_deferred`/`gate_fallback`，映射成 PipelineEvent + `knownIssues` —— 单向数据流。
- 同步更新 `mimo-pipeline.test.ts` L187/226/265 等 ~4 个断言（事件来源从 wave 层变为 harness 转发）。

### 3.3 统一优先级比较器

- 把 `priority` 提升为 `TaskContract` 的**正式可选字段**（`priority?: "P0"|"P1"|"P2"|"P3"`），删除 `ReadyQueue` 里的 `(c as any)`。
- `ReadyQueue.sort` 与 `TaskGraphIndex.comparePriority` 抽出一个共享 `compareTaskPriority(a, b, graph)`：先 `priority`，再 `unresolvedCount`，再 downstream 影响面，最后 `taskId` 字典序。两处 import 同一函数。

### 3.4 删除 RunningSet 的 glob 重复跟踪

`RunningSet.getActiveGlobs()` 与 `WriteLockManager` 的活动锁重复。写锁权威统一到 `ResourceManager`（见 #4），`RunningSet` 只保留任务元数据（abortController、startedAt、personaId）。

## 4. 迁移步骤（TDD，逐步可回归）

1. **测试先行**：写「跨阶段 requirement 未满足时 harness 自行 defer（不依赖上层 applyLaunchGate）」的失败用例。
2. 引入 `ResultView`，`promote` 合并视图，删除 `intraReqs` 过滤 → 转绿。
3. 写「wave 层不再调用 applyLaunchGate 仍能正确 defer/重试」用例 → 迁移逻辑 → 转绿。
4. `priority` 字段化 + 共享比较器，覆盖「P0 先于 P2」「同优先级按 unresolvedCount」用例。
5. 删除 `RunningSet.getActiveGlobs`，确认无引用。
6. 跑全量 `tests/unit/dynamic-harness.test.ts` + `tests/unit/*pipeline*` 回归。

## 5. 风险与回滚

- **风险**：`MiMoPipeline` 对 `knownIssues` 文案有下游断言（W3.5 mission check 读取）。迁移 defer 文案时需保持 `knownIssues` 字符串格式兼容，或同步更新 mission check 解析。
- **回滚**：`ResultView` 为可选注入，不传时 harness 退回「仅本次 invocation」旧行为；可灰度。

## 6. 不在本方案内

- 全局并发收束到 `ResourceManager`（#4）—— 已独立处理。
- deferred/blocked 任务写回 results（#1/#2）、死锁守卫（#3）、abort 接线（#9）—— 已独立处理。本方案假设这些先落地。
