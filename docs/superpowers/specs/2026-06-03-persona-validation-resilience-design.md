# 设计：W0 persona 校验韧性化（方案 C）

- 日期：2026-06-03
- 作者：fengxijiu / Claude
- 状态：已实施 + 验证通过（2026-06-03）
- 触发问题：`[W0] phase[1].tasks[0].persona must be one of master_planner,vision,repo_scout,context_builder,code_executor,test_writer,test_runner,runtime_debug,reviewer,docs` 导致整条 MiMo pipeline 在 W0 直接 fail。

## 背景与根因

`src/orchestration/TaskCompiler.ts:108` 对 master_planner LLM 输出的 `<task_dag>` 做严格校验：persona 必须命中 `Set(listPersonaIds())` 中的 10 个 id，**大小写敏感、字符敏感**，无任何归一化或别名。

`src/orchestration/MiMoPipeline.ts:132-136` 在 `compileCoarse` 失败时直接 `pipeline_error`，**无任何重试或回灌**。

`src/personas/prompts/master-planner.md` 没有完整枚举 10 个合法 id；只有部分通过示例出现（`vision/repo_scout/code_executor/context_builder/test_writer/test_runner/reviewer`）。`runtime_debug` 与 `docs` 未在示例中出现；`mission_checker` 作为 W3.5 inline role 存在 `prompts/mission_checker.md` 但**未注册为 persona**，模型可能误用。

故障三层链路：

1. **Prompt 侧**：合法集合非显式 → 模型偶发漂移（大小写、横线、近义词、`mission_checker`）。
2. **校验侧**：零容忍 → 任何细微漂移都失败。
3. **Pipeline 侧**：零重试 → 一次漂移就毁掉整次运行。

## 设计目标

- **单一真实来源（SSOT）**：合法 persona id 由 `PersonaRegistry` 派生，prompt 与校验器共用，禁止重复定义。
- **轻度归一**：吸收无歧义的表面差异（大小写、`-`/`_`），不引入语义别名（避免掩盖 bug）。
- **一次性自愈**：W0 校验失败时把错误回灌给 master_planner 自纠一次，失败即终止。
- **更好诊断**：错误消息包含原始值。

非目标：

- 不引入开放别名表（如 `developer→code_executor`），保持语义严格。
- 不重构 master_planner prompt 整体结构。
- 不改变 10 个 persona 的语义、权限或名单本身。

## 方案 C：三处协同改动

### 改动 1 — master prompt 动态注入合法名单（SSOT）

**文件**：`src/personas/PersonaRegistry.ts`，`buildMasterPrompt()`

在加载 `master-planner.md` 后、`renderInlineSkillsForPersona` 之前，拼入一段由 `listPersonaIds()` 实时生成的硬约束块：

```
## Valid Persona IDs

Use EXACTLY one of these strings (lowercase, underscore-separated) for any
`persona` field in <task_dag> / <refine>:

- master_planner
- vision
- repo_scout
- context_builder
- code_executor
- test_writer
- test_runner
- runtime_debug
- reviewer
- docs

Do NOT use synonyms (e.g. "developer", "tester", "qa") or alternate casings
(e.g. "Code_Executor", "code-executor"). `mission_checker` is a W3.5 inline
role and MUST NOT appear as a coarse DAG persona. Any other value is
rejected by the compiler and aborts the run.
```

**文件**：`src/personas/prompts/master-planner.md`

在 DAG 示例里补 `runtime_debug` 与 `docs` 的示范行（few-shot 覆盖全集）。例如在 P2 之后加 P3 phase 示范 `docs`，在合适位置示范 `runtime_debug`（用于失败诊断 task）。

### 改动 2 — TaskCompiler 轻度归一 + 更好错误消息

**文件**：`src/orchestration/TaskCompiler.ts:99,108-109`

新增内部辅助：

```ts
function normalizePersona(s: string): string {
  return s.trim().toLowerCase().replace(/-/g, "_");
}
```

校验改为：

```ts
const raw_persona = raw.persona ?? raw.role;
const persona = typeof raw_persona === "string" ? normalizePersona(raw_persona) : undefined;
if (!persona || !VALID_PERSONA_IDS.has(persona as PersonaId))
  return {
    ok: false,
    error: `${prefix}.persona must be one of ${[...VALID_PERSONA_IDS].join(",")} (got ${JSON.stringify(raw_persona)})`,
  };
```

并在 `task` 构造处用归一后的值：`personaId: persona as PersonaId`。

**不**引入别名表：`developer`、`tester`、`mission_checker` 等仍报错；这是有意的语义边界。

### 改动 3 — MiMoPipeline W0 一次性自愈

**文件**：`src/orchestration/MiMoPipeline.ts`，W0 段（约 126-136 行）

将单次调用改造为最多两次：

```
attempt 1:
  compiledText = planner.compile(userRequest, memory.text)
  compiled = compileCoarse(compiledText)
  if compiled.ok → 继续 W0.5
  emit: { type: "compile_retry", phase: "W0", error: compiled.error }

attempt 2 (一次性):
  feedback = `Your previous <task_dag> failed compiler validation:\n${compiled.error}\n\nRe-emit the ENTIRE <task_dag> block using only the listed persona ids.`
  compiledText = planner.compile(userRequest, memory.text + "\n\n" + feedback)
  compiled = compileCoarse(compiledText)
  if compiled.ok → 继续
  else → pipeline_error（终态）
```

实现细节：

- **扩展 `PlannerBridge.compile` 接口**：新增可选第三参数 `feedback?: string`。
  ```ts
  compile(userRequest: string, memoryPrefix: string, feedback?: string): Promise<string>;
  ```
  `ClientAdapters.ts` 中的实现把 `feedback` 作为附加 user 消息追加到 LLM 请求；不传时行为与原签名等价。
- **新增独立事件类型 `compile_retry`**：
  ```ts
  | { type: "compile_retry"; phase: "W0"; attempt: 1; error: string }
  ```
  与 `pipeline_error` 分离，UI 可以单独渲染（如 toast/灰色提示）而不误报为致命错误。
- 重试上限**固定为 1**，杜绝无限循环。
- 第二次仍失败：emit `pipeline_error`，error 形如 `W0 compile failed twice; first: <e1>; retry: <e2>`，便于诊断。

### 改动 4 — `mission_checker` 越界显式禁止

合并到改动 1 的 prompt 文本中（已包含）。无独立代码改动。

## 数据流

```
master_planner LLM
  └─ <task_dag>{ persona: "Code-Executor" }
       ↓
TaskCompiler.compileCoarse
  ├─ normalize → "code_executor"
  └─ Set.has("code_executor") = true ✓
       ↓
W0.5 Refine
```

```
master_planner LLM
  └─ <task_dag>{ persona: "developer" }
       ↓
TaskCompiler.compileCoarse
  ├─ normalize → "developer"
  └─ Set.has("developer") = false ✗
       ↓
MiMoPipeline W0 attempt 2
  └─ planner.compile(..., memory + feedback)
       └─ <task_dag>{ persona: "code_executor" }  (LLM 自纠)
            ↓
       compileCoarse ✓ → W0.5
```

## 测试计划

新增 `src/orchestration/TaskCompiler.test.ts`（若不存在就建）：

| 用例 | 输入 persona 字段 | 期望 |
|---|---|---|
| 严格命中 | `"code_executor"` | ok |
| 大小写归一 | `"Code_Executor"` | ok，归一为 `code_executor` |
| 横线归一 | `"code-executor"` | ok |
| 复合归一 | `" Code-Executor "` | ok（含前后空格） |
| 同义词拒绝 | `"developer"` | fail，error 含 `(got "developer")` |
| 误用 W3.5 角色 | `"mission_checker"` | fail，error 含原值 |
| 缺失字段 | `undefined` | fail |
| 非字符串 | `123` | fail |
| `role` 别名字段 | `{ role: "Vision" }` | ok（保留现有 fallback） |

新增 pipeline 集成测试（或扩展已有）：

- 模拟 planner 第 1 次返回非法 persona、第 2 次返回合法 persona → pipeline 成功，发出 `compile_retry` 事件一次。
- 模拟 planner 两次都返回非法 → pipeline_error，error 包含两次错误。

回归：跑现有 W0/W0.5/W2/W3/W4 测试套件，确保未破坏。

## 错误处理

- TaskCompiler：仅返回结构化 `CompileFailure`（已有），新增原值字段嵌入 message。
- MiMoPipeline：第二次失败的 `pipeline_error.error` 形如 `W0 compile failed twice; first: <e1>; retry: <e2>`，便于上游 UI/日志定位。
- 不抛异常、不静默吞错。

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| 归一化掩盖真实漂移趋势 | 错误消息保留原值；可在日志层加 `compile_retry` 计数指标 |
| LLM 第二次依然漂移、浪费一次 LLM 调用 | 上限固定 1 次；prompt 改动 1 已大幅降低漂移概率 |
| Prompt 注入的硬名单与 registry 漂移 | SSOT 保证：名单从 `listPersonaIds()` 生成，registry 改名即时同步 |
| 现有依赖严格大小写的下游 | grep 显示 PersonaId 比较只发生在 PersonaRegistry/TaskCompiler/TaskGraph 内部，全部使用 PersonaId 类型；归一只发生在校验入口，下游拿到的已经是规范值 |

回滚：每处改动独立提交（4 个 commit），任何一处都可单独 revert 不影响其他。

## 验收标准

- [ ] `pnpm test` / `npm test` 全绿
- [ ] `TaskCompiler.test.ts` 9 个新用例通过
- [ ] pipeline 集成测试：单次漂移→自愈成功、双次漂移→明确报错
- [ ] 手动跑一次真实 MiMo pipeline，观察 master prompt 中含完整 10-id 名单
- [ ] 故意构造非法 persona，确认 UI/CLI 收到的 error 包含原值

## 单一来源信息

- 合法 persona id：`src/personas/PersonaRegistry.ts` → `listPersonaIds()`
- 校验入口：`src/orchestration/TaskCompiler.ts` → `validateTask`
- W0 重试入口：`src/orchestration/MiMoPipeline.ts` → W0 段

任何新增 persona：只改 PersonaRegistry，prompt 注入、校验、UI 提示自动同步。
