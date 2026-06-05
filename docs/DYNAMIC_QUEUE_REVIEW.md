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
