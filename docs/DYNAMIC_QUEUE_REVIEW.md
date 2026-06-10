# Code Review: Dynamic Ready Queue Harness (Round 2)

## Summary

3 个 Blocker 已全部修复，编译通过，回归无新增失败。调度循环的逻辑正确，通知机制无竞态。`propagateFailure` 的多上游判断准确。发现 1 个新的轻微冗余调用，以及 1 个遗留的 `ResourceManager` `acquire` 竞态窗口（低概率），均不阻塞合并。

---

## Findings (第二轮)

### 💡 Suggestion

#### S1 — `.catch()` 中冗余的 `propagateFailure` 调用

**位置**：[`DynamicHarness.ts:165`](file:///c:/workspace/minimum/src/orchestration/DynamicHarness.ts#L165)

**观察**：`.catch()` handler 在调用 `handleTaskComplete` 之前先调用了 `graph.propagateFailure(taskId)`。但 `handleTaskComplete` 对 `status === "error"` 的结果也会调用 `propagateFailure`。这导致对同一失败传播了两次（第二次是 no-op，因为下游已标记为 skipped）。

**影响**：轻微冗余计算，不影响正确性。

**建议**：删除第 165 行的 `graph.propagateFailure(taskId)`，只保留 `emit` 和 `handleTaskComplete` 调用：

```typescript
.catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  const failResult: TaskResult = { ... };
  emit?.({ type: "task_failed", result: failResult, error: msg });
  // graph.propagateFailure 已由 handleTaskComplete 处理
  handleTaskComplete(taskId, personaId, failResult);
});
```

---

#### S2 — `ResourceManager.acquire` 非原子性问题（低概率）

**位置**：[`ResourceManager.ts:78-115`](file:///c:/workspace/minimum/src/orchestration/ResourceManager.ts#L78-L115)

**观察**：`acquire` 先调 `tryLock` 获取写锁，然后做其他并发检查，中间如果失败则 `unlock` 回滚。在单线程 Node.js 中理论上没有真正的竞态，但如果将来 `acquire` 中有 `await` 调用（目前没有），这个中间状态会暴露。当前不会触发，属于防御性设计范畴。

**建议**：将 `tryLock` 移到所有其他检查通过之后才执行，避免中间 rollback：

```typescript
// 先做轻量检查
const reasons = [];
if (globalActive >= maxGlobal) reasons.push({...});
if (personaActive >= personaCap) reasons.push({...});
// ... etc
if (reasons.length > 0) return { ok: false, reasons };

// 最后才申请写锁（可能阻塞）
const conflicts = writeLocks.tryLock(taskId, allowedGlobs);
if (conflicts.length > 0) return { ok: false, reasons: [{ type: "write_lock", ... }] };

// 全部通过，提交
this.globalActive++;
// ...
```

### ✅ 已修复确认

| Blocker | 修复方案 | 状态 |
|---------|----------|------|
| B1: DynamicHarness 缺少调度循环 | `wake` 通知 + `drainQueue` + `while` 主循环 | ✅ |
| B2: `propagateFailure` 传播逻辑错误 | 检查全部上游终态 + anyFailed 判断 | ✅ |
| B3: 结果重复收集 | 仅从 `harness_complete` 收集，删除 `task_done` 分支 | ✅ |

### ✅ 未变更文件确认

| 文件 | 状态 |
|------|------|
| `WaveHarness.ts` | 无问题（上次复核的 B3 指 `collectHarnessResults`，`WaveHarness.runToCompletion` 早已正确） |
| `ReadyQueue.ts` | 无逻辑问题 |
| `ResultStore.ts` | 无逻辑问题 |
| `ArtifactIndex.ts` | 无逻辑问题，`ARTIFACT_TAGS` 与 `LaunchGate.ts` 重复但非 bug |
| `RunningSet.ts` | 无逻辑问题，`conflictsWith` JSDoc 不匹配但非 bug |
| `WriteLockManager.ts` | 无逻辑问题 |
| `ResourceManager.ts` | S2 低概率窗口 |
| `MiMoPipeline.ts` | 事件转换链路正确 |

---

## Verdict

✅ **Approve** — 3 个 Blocker 已验证通过，2 个 Suggestion 不阻塞合并。

---

# Code Review: Dynamic Ready Queue Harness (Round 3)

> 分支 `dynamic-harness-review`，对照 `docs/SUBAGENT_OPTIMISE.md` 方案重新核查并优化。

## Summary

调度循环、失败传播 (`propagateFailure` 多上游判断)、环检测、Idle Detection 均正确，`tsc --noEmit` 通过，回归无新增失败（14 个失败全部为预存的 Windows 路径 / hooks / personas / policy 问题，与本模块无关）。

本轮发现 **1 个实质缺口已修复**（写锁未接入调度循环），并落实了上一轮的 2 条 Suggestion。另记录 2 项建议的后续项（不阻塞）。

---

## 已修复 (本轮)

### B4 — 写锁 (§8) 未接入 DynamicHarness 调度循环 ✅

**位置**：[`DynamicHarness.ts`](file:///c:/workspace/minimum/src/orchestration/DynamicHarness.ts)

**观察**：`WriteLockManager` / `ResourceManager` 已完整实现、导出且有 glob 判交逻辑，但 `DynamicHarness.run` 从未实例化或调用它们——内联的 `canLaunch` 只检查全局并发与 persona 并发。结果：方案第 8 章重点强调的「写同一文件的任务不能并发」**完全未生效**，两个 `allowedGlobs` 重叠的写任务会并行执行，存在写冲突 / 互相覆盖风险。

**修复**：在调度循环中接入 `WriteLockManager`——
- 启动前 `writeLocks.tryLock(taskId, allowedGlobs)`，冲突则发 `write_lock_wait` 事件并重新入队；
- 任务完成（`handleTaskComplete`）时 `writeLocks.unlock(taskId)`，下一次 drain 自动重试被阻塞的任务。

read-only 任务（`allowedGlobs` 为空）不参与冲突，可正常并行。

**测试**：新增 2 个用例——重叠 glob 的独立任务串行执行（peak 并发 = 1，且发出 `write_lock_wait`）、不相交 glob 的任务并行执行（peak 并发 = 2）。

### S1 — `.catch()` 冗余 `propagateFailure` ✅

已删除，失败传播与锁释放统一由 `handleTaskComplete` 的 `error` 分支处理。

### S2 — `ResourceManager.acquire` 非原子写锁回滚 ✅

改为：先做全部无副作用检查（用 `findConflicts` 只读探测写锁），全部通过后才 `tryLock` 提交，消除中间 rollback 窗口。

### 顺手清理

`DynamicHarness.runToCompletion` 改用共享的 `collectHarnessResults`，去除与 `DagHarness` 的重复实现。

---

### 测试覆盖缺口

`ResourceManager` / `WriteLockManager` / `ReadyQueue` / `TaskGraphIndex` 仍无独立单测，建议补充（`globsOverlap` 边界、环检测、`propagateFailure` 多上游矩阵）。

## Verdict (Round 3)

✅ **Approve** — 写锁缺口已修复并加测试，编译与回归通过；F1/F2 列为后续项。

---

# Round 4 — F1 + F2 落地 & 移除旧调度模式

## F1 — Launch Gate 接入 DynamicHarness（§5.2 Artifact Gate）✅

`DynamicHarness` 现在在任务进入 Ready Queue 前评估 `evaluateLaunchGate`：硬依赖满足后，若 `launchRequirements` 要求的 artifact 缺失则标 `deferred` 并发 `resource_wait`，而非直接 ready。每次上游完成后 `reevaluateDeferred()` 重评 deferred 任务（新 artifact 可能解锁它们）。

**关键约束（避免与 pipeline 双重 gate）**：harness 内 gate **只校验 sourceTaskId 属于本次调用的需求**。跨阶段需求（如 W2/3 任务依赖 W1 perception artifact）仍由 `MiMoPipeline.applyLaunchGate`（持有全量跨阶段结果）负责——否则 harness 会因看不到上一阶段结果而错误 defer。`postStaticCompile` 同样留给 pipeline。

## F2 — degraded 上游走 readonly fallback 而非 skip（§9）✅

`degraded`（如 repo_scout 降级）不再 `propagateFailure`：改为 `tryUnlock(taskId, "degraded")` 解锁下游，再由 launch gate 经 `canUseReadonlyFallback` 决定继续或 deferred。`TaskRuntimeStatus` 新增 `degraded` 终态，并纳入 `propagateFailure` / `isComplete` / idle 诊断的终态集合（`degraded` 不计入 `anyFailed`）。

附带修复：idle 检测原先在主循环退出后无法触发（最后一个任务只解锁 deferred 下游时直接退出），现抽出 `emitIdleIfIncomplete()` 在循环内与循环后各调用一次，且 `deferred` 计数改用 `graph.getDeferredIds().length`（原 `reason.includes("deferred")` 永不命中）。

新增测试：F1 缺 artifact → defer（含 `resource_wait` + `queue_idle`）、artifact 齐备 → 运行、F2 degraded → fallback 放行。

## 移除旧调度模式 ✅

- 删除旧调度器文件及对应测试。
- `MiMoPipeline`：去掉 `harnessMode` 选项；统一由 `DynamicHarness` 发出 `HarnessEvent`。
- `index.ts` 去除 `WaveHarness` / `schedule` / `ScheduleOptions` 导出；`HarnessEvent` 删除无人 emit 的 `wave_start` / `wave_complete`。
- `DagHarness` / 其它注释里的 WaveScheduler/WaveHarness 引用一并清理。
- `TaskGraph.ts` 的静态 DAG 分层工具**保留**——仅用于环检测/分层/glob 冲突，不再代表运行时模式。

## 回归

`tsc --noEmit` 通过。orchestration 相关测试全绿（dynamic-harness / mimo-pipeline / launch-gate / task-compiler / task-runner / worker-loop）。全量回归 17 失败 = 14 个预存平台问题（Windows 路径 / hooks / personas / policy）+ 3 个与本工作无关的并发改动（skills/personas 的 `learn-service` / `persona-skill-router` / `integrated-learn`，因 stale `.js` 删除后 `.ts` 路由更新但测试期望值未更新）。

## Verdict (Round 4)

✅ **Approve** — F1/F2 落地并加测试，旧执行路径已移除，DynamicHarness 成为唯一调度器。
