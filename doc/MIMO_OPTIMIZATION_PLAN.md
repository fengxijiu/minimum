# MiMo TUI 优化方案（基于 Reasonix vs CodeWhale 对比）

## 背景

`minimum` 已实现 MiMoLoop、上下文折叠、工具修复、完整性检查、迭代重试等模块。
本方案基于对两个参考实现的工程哲学对比，针对 MiMo 模型的实测弱点
（Code Defect、部分实现、多轮不稳、长轨迹丢上下文）给出落地优化。

## 一、Reasonix vs CodeWhale：工程哲学对比

| 维度 | DeepSeek-Reasonix (TS/Ink) | CodeWhale (Rust/tokio) | MiMo 取向 |
|------|---------------------------|------------------------|-----------|
| 核心隐喻 | Cache-first，保前缀稳定降成本 | Engine + capacity，保执行不失控 | 学 CodeWhale |
| 失控防护 | repair 事后补救坏 JSON | LoopGuard + CapacityController 事前刹车 | 两者都要 |
| 正确性保障 | 弱（靠模型自觉） | 强（LSP 诊断 + sandbox + 审批） | 急需 LSP |
| 状态模型 | AppendOnlyLog（纯追加） | CoherenceState + 快照（可回滚） | 学 CodeWhale |
| 开发效率 | 高（React 组件化） | 低（Rust 编译慢） | 学 Reasonix |

**结论**：以 CodeWhale 的防护哲学为骨，Reasonix 的 TS 生态为皮。

## 二、病症 → 药方映射

| MiMo 病症 | 根治手段 | minimum 现状 |
|-----------|---------|-------------|
| Code Defect（变量/类型错） | LSP/typecheck 诊断回灌 | 仅静态 PatternChecker，无 LSP |
| 部分实现（写一半） | CapacityCheckpoint 强制收尾 | CompletenessChecker 有自评偏差 |
| 多轮不稳（MT@4 差 43%） | CoherenceState + 快照回滚 | IterationManager 重试但无回滚 |
| 长轨迹丢上下文 | compaction + capacity | 已实现，阈值 0.7/0.75 |

## 三、实测发现的缺口

- **CapacityController 是死代码**：仅在 `src/index.ts` 导出，未接入 `MiMoLoop`。
  循环仅有行内预算硬停（`src/loop/MiMoLoop.ts:128`）。
- **ReadTracker 不存在**：TUI_DESIGN 设计的"先读后写"全代码库无实现。
- **阈值之争已解决**：`ContextManager` 采用保守值 0.7/0.75（`src/context/ContextManager.ts:34-35`）。

## 四、TODO List

### P0 — 接通已有死代码（零新依赖）

- [ ] **P0-1 CapacityController 接入主循环**
  - 在 `MiMoLoop` 每轮模型调用后 `observe({ turnIndex, promptTokens, maxTokens, toolCalls })`
  - `targeted_refresh` → 触发上下文压缩；`verify_and_replan` → 注入收尾/复核 steer
  - 新增 `capacity` LoopEvent，TUI 可显示风险档位
- [ ] **P0-2 ReadTracker 防盲改**
  - 新增 `src/loop/ReadTracker.ts`：按解析后的绝对路径记录已读文件
  - `read_file` 成功后 `markRead`；`edit_file`/`write_file` 执行前若未读则拦截返回错误
  - 与 StormBreaker 协同：read 按路径去重，防止刷豁免

### P1 — CodeWhale 正确性闭环

- [ ] **P1-1 LSP/typecheck 诊断回灌**
  - `write_file`/`edit_file` 后对 TS/JS 跑 `tsc --noEmit` 或 ESLint，诊断并入 tool_result
- [ ] **P1-2 CoherenceState + 快照回滚**
  - 工具执行前打轻量快照（git stash / side-branch），验证失败回滚再重试

### P2 — 修掉设计风险

- [ ] **P2-1 CompletenessChecker 去自评偏差**：默认确定性检查，仅高风险任务触发一次模型自评
- [ ] **P2-2 配置统一**：阈值与开关集中到 config，避免两份方案数值漂移

## 五、不做

- 不引入 Rust/sandbox（Seatbelt/Landlock 移植成本高、收益低）
- 不照搬 Reasonix 4 阶段 repair 全家桶（MiMo 病在代码不在 JSON）

---
**版本**: 1.0.0 ｜ **范围**: minimum TUI
