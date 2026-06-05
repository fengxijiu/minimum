# Dynamic Ready Queue Harness 实施进度

> 基于 `docs/SUBAGENT_OPTIMISE.md` 方案，将 WaveScheduler 升级为 DAG 驱动的动态调度器。

## 进度总览

| 阶段 | 状态 | 完成时间 |
|------|------|----------|
| Phase 1: DagHarness 接口 + WaveHarness 重构 | ✅ 完成 | 2026-06-03 |
| Phase 2: Dynamic Ready Queue 核心 | ✅ 完成 | 2026-06-03 |
| Phase 3: ResourceManager + WriteLockManager | ✅ 完成 | 2026-06-03 |
| Phase 4: Idle Detection + HarnessEvent 事件系统 | ✅ 完成 | 2026-06-03 |
| Phase 5: MiMoPipeline 接入 Dynamic 模式 | ✅ 完成 | 2026-06-03 |
| Phase 6: TUI 展示从 Wave 切换为 Flow | ✅ 完成 | 2026-06-03 |
| 编译验证 | ✅ `npx tsc --noEmit` 通过 | 2026-06-03 |

---

## 变更摘要

### 新建文件 (12 个)

| 文件 | 用途 |
|------|------|
| `src/orchestration/DagHarness.ts` | 统一 Harness 接口 (run + runToCompletion) |
| `src/orchestration/WaveHarness.ts` | Wave 调度器适配 (封装 buildWaves + schedule) |
| `src/orchestration/HarnessEvent.ts` | 统一事件类型 (任务/资源/空闲/worker 事件) |
| `src/orchestration/TaskGraphIndex.ts` | 运行时图索引 (上游/下游/depCount/状态/诊断) |
| `src/orchestration/ReadyQueue.ts` | 优先级排序就绪队列 (P0→P3 + depDepth + taskId) |
| `src/orchestration/ResultStore.ts` | 任务结果存储 (按 status 过滤) |
| `src/orchestration/ArtifactIndex.ts` | 结构化 artifact 索引 (XML block 抽取) |
| `src/orchestration/RunningSet.ts` | 运行中任务追踪 (并发控制、写锁检测、取消) |
| `src/orchestration/DynamicHarness.ts` | 动态调度循环 (实时解锁 + Idle Detection) |
| `src/orchestration/ResourceManager.ts` | 全局资源调度 (并发/写锁/install/shell) |
| `src/orchestration/WriteLockManager.ts` | 写锁冲突检测 (保守 glob 判交, 零外部依赖) |
| `docs/DYNAMIC_QUEUE_IMPLEMENTATION.md` | 实施进度文档 |

### 改动文件 (2 个)

| 文件 | 改动内容 |
|------|----------|
| `src/orchestration/MiMoPipeline.ts` | `runWaves` 改用 DagHarness; 增加 `harnessMode: "wave" | "dynamic"` |
| `src/orchestration/index.ts` | 导出所有新模块 |

### 架构

```
                 DagHarness (interface)
                /                    \
       WaveHarness              DynamicHarness
       (现有行为)               (新: 实时解锁)
            │                        │
     buildWaves             TaskGraphIndex
          +                  ReadyQueue
     schedule                ResultStore
          +                  ArtifactIndex
     runTask                 RunningSet
                             ResourceManager
                               └── WriteLockManager
```

### 使用方式

```typescript
// Wave 模式 (默认, 行为不变)
runPipeline(userRequest, { projectRoot, planner, executor });

// Dynamic 模式 (实时依赖解锁)
runPipeline(userRequest, {
  projectRoot, planner, executor,
  harnessMode: "dynamic",
});
```

### 编译状态

`npx tsc --noEmit` — **通过** (exit 0)

### 测试回归

`npx vitest run` — **1010/1019 通过**  
5 个失败均为预存问题 (merge conflict markers / Windows path / shell ENOENT)，与本次改动无关。
