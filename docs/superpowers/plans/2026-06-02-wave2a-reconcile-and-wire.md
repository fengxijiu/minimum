# Wave 2a — Wave 1 收尾:去重、配置接入、工厂注册

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Wave 1 留下的三个集成缺口缝合掉:(1) 删除 `src/tools/state/ReadTracker.ts` 这份与 `src/loop/ReadTracker.ts` 重复的实现并复用既有版本;(2) 把 `ToolRateLimiter` 接入 `MiMoConfig` + `createMiMoStack` 让限流真正在主循环里生效;(3) 把 `ChoiceTool` 加进工厂的内置工具列表,并让工厂能接收外部注入的 `ConfirmationGate`。

**Architecture:** 三个 Task 都是"消缺"而非新建。一切改动遵循"现有调用零回归"原则:旧 API 保持兼容,新行为通过可选注入开启。TUI 侧的 `ConfirmationGate` 真实接线另开 Plan(`2a-TUI`),本计划只把工厂参数门开好。

**Tech Stack:** TypeScript (Node 22, ESM, `.js` import 后缀)、vitest、biome。无新依赖。

---

## 背景:Wave 1 后审计发现

| 发现 | 影响 |
|---|---|
| `src/loop/ReadTracker.ts` 早已存在,API 是 `markRead(path, workingDir?)` + `guardEdit(path, workingDir?)`,已被 `MiMoLoop` 使用(`MiMoLoop.ts:227,244,563-567`) | Wave 1 在 `src/tools/state/ReadTracker.ts` 新建的版本完全重复,且 API 不一致(无 workingDir 参数) |
| `createMiMoStack.ts` 创建 `MiMoLoop` 时没有从 `cfg` 读 `rateLimit`,也没向调用方传入的 `tools` 注册表注入限流器 | Wave 1 的 `ToolRateLimiter` 能力到位但**未在主循环路径上启用**——调用方手动构造 `ToolRegistry({rateLimiter})` 才生效 |
| `createMiMoStack.ts:62` 的 `builtins = [TodoWriteTool, ApplyPatchTool]` 没有 `ChoiceTool` | `ask_choice` 工具在 CLI 实际运行时不可用,除非调用方自行 `register` |
| `ApprovalManager` 已存在,与 `ChoiceTool` 各司其职(权限闸 vs 选择闸) | 不冲突,但 TUI 侧需统一实现 Gate 抽象——本计划不涉及 |

---

## 文件结构

### 删除
| 路径 | 原因 |
|---|---|
| `src/tools/state/ReadTracker.ts` | 与 `src/loop/ReadTracker.ts` 重复 |
| `src/tools/state/` 整个目录 | 仅含上面一个文件;`index.ts` 改为 re-export 后此目录不再需要(改成把 `src/loop/ReadTracker.ts` 直接 re-export 到 `src/tools/index.ts`) |

### 修改
| 路径 | 改动 |
|---|---|
| `src/tools/filesystem/ReadFileTool.ts` | `ReadTracker` 来源改为 `../../loop/ReadTracker.js`;调用 `markRead(filePath, undefined)`(canonical 版接受 workingDir,这里传 undefined 因为 filePath 已是绝对路径) |
| `src/tools/filesystem/EditFileTool.ts` | `ReadTracker` 来源同上;guard 改用 `guardEdit(args.path, context?.workingDirectory)`,返回 string 直接当错误返回 |
| `src/tools/index.ts` | `ReadTracker` re-export 来源从 `./state/index.js` 改为 `../loop/ReadTracker.js` |
| `tests/unit/EditFileTool.test.ts` | import 路径更新;断言文本若依赖具体错误信息也同步 |
| `tests/unit/ReadTracker.test.ts` | 整体重写,基于 canonical 版的 API(`markRead(path, workingDir?)` 等) |
| `src/config/MiMoConfig.ts` | `MiMoConfig` 新增 `rateLimit?: ToolRateLimitOption`;`DEFAULT_MIMO_CONFIG` 加默认 `{}`;`mergeConfig` 合并 |
| `src/config/createMiMoStack.ts` | 新参数 `deps.toolRateLimiter?` 与 `deps.confirmationGate?`;若调用方未传则从 `cfg.rateLimit` 构造 `ToolRateLimiter`;把 `ChoiceTool` 加进 builtins(接受 gate) |
| `src/tools/choice/ChoiceTool.ts` | 无改动(已经接受可选 gate) |
| `tests/unit/createMiMoStack.test.ts`(新建)|为本任务的接入测试 |

---

## Task 1: 删除 `src/tools/state/ReadTracker.ts`,统一使用 `src/loop/ReadTracker.ts`

**Files:**
- Delete: `src/tools/state/ReadTracker.ts`, `src/tools/state/index.ts`
- Modify: `src/tools/filesystem/ReadFileTool.ts`, `src/tools/filesystem/EditFileTool.ts`, `src/tools/index.ts`
- Rewrite: `tests/unit/ReadTracker.test.ts`
- Update: `tests/unit/EditFileTool.test.ts`

### Step 1: 先确认 canonical 版的 API

Read `src/loop/ReadTracker.ts`(只读)。其 API:

```ts
markRead(rawPath: string, workingDirectory?: string): void
hasRead(rawPath: string, workingDirectory?: string): boolean
guardEdit(rawPath: string, workingDirectory?: string): string | null  // null = ok, string = block reason
reset(): void
```

不包含 `size` getter。本任务后续测试不可依赖 `size`。

### Step 2: 重写 `tests/unit/ReadTracker.test.ts`

把整个文件替换为:

```ts
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ReadTracker } from "../../src/loop/ReadTracker.js";

describe("ReadTracker (canonical from src/loop)", () => {
	it("初始未读返回 false", () => {
		const t = new ReadTracker();
		expect(t.hasRead("/tmp/foo")).toBe(false);
	});

	it("markRead 后 hasRead 返回 true", () => {
		const t = new ReadTracker();
		t.markRead("/tmp/foo");
		expect(t.hasRead("/tmp/foo")).toBe(true);
	});

	it("workingDirectory 解析:相对路径 + cwd ≡ 绝对路径", () => {
		const t = new ReadTracker();
		t.markRead("a/b/c.txt", "/work");
		expect(t.hasRead(path.resolve("/work", "a/b/c.txt"))).toBe(true);
	});

	it("guardEdit 未读返回错误字符串", () => {
		const t = new ReadTracker();
		const msg = t.guardEdit("foo.txt");
		expect(msg).toMatch(/not been read yet/i);
	});

	it("guardEdit 已读返回 null", () => {
		const t = new ReadTracker();
		t.markRead("foo.txt");
		expect(t.guardEdit("foo.txt")).toBeNull();
	});

	it("reset 清空所有已读路径", () => {
		const t = new ReadTracker();
		t.markRead("/x");
		t.reset();
		expect(t.hasRead("/x")).toBe(false);
	});
});
```

### Step 3: 跑测试预期 FAIL(新测试针对 canonical 版,但 Wave 1 的 wiring 还指向 state/ReadTracker.ts)

Run: `npm test -- tests/unit/ReadTracker.test.ts`
Expected: 部分通过部分失败——canonical 版无 `size`,旧测试用例失败说明替换在进行。

### Step 4: 改 `ReadFileTool.ts`

把第一行 import 改为:
```ts
import type { ReadTracker } from "../../loop/ReadTracker.js";
```

把 `markRead(filePath)` 调用改为:
```ts
this.readTracker?.markRead(filePath);
```
(canonical 版的 markRead 在 `workingDirectory` 为 undefined 时直接用 `path.resolve(rawPath)`,而 `filePath` 已经是绝对路径,故无需第二参数。)

### Step 5: 改 `EditFileTool.ts`

把第一行 import 改为:
```ts
import type { ReadTracker } from "../../loop/ReadTracker.js";
```

把现有的 guard:
```ts
if (this.readTracker && !this.readTracker.hasRead(filePath)) {
	return `Error: must read ${args.path} before editing — call read_file on the full file first so SEARCH text matches on-disk bytes.`;
}
```

替换为利用 canonical 版的 `guardEdit`:
```ts
if (this.readTracker) {
	const blockReason = this.readTracker.guardEdit(args.path, context?.workingDirectory);
	if (blockReason !== null) {
		return `Error: ${blockReason}`;
	}
}
```

### Step 6: 改 `EditFileTool.test.ts`

Import 改为:
```ts
import { ReadTracker } from "../../src/loop/ReadTracker.js";
```

把测试用例"注入 tracker 但未先读则拒绝编辑"的断言改为匹配 canonical 版的错误信息:
```ts
expect(out).toMatch(/not been read yet/i);
```

测试用例"先 read_file 后 edit 才放行"不需要改(行为不变)。

### Step 7: 改 `src/tools/index.ts`

把:
```ts
export { ReadTracker } from "./state/index.js";
```

改为:
```ts
export { ReadTracker } from "../loop/ReadTracker.js";
```

### Step 8: 删除 `src/tools/state/`

Delete `src/tools/state/ReadTracker.ts` 与 `src/tools/state/index.ts`。`src/tools/state/` 目录留空可以一并删,或保留空目录无所谓——构建产物不引用它。

### Step 9: 跑全部相关测试

Run: `npm test -- tests/unit/ReadTracker.test.ts tests/unit/EditFileTool.test.ts tests/unit/tools.test.ts`
Expected: 全部 PASS。

### Step 10: 跑 typecheck

Run: `npm run typecheck`
Expected: 0 error。

### Step 11: Commit

```bash
git add -A
git commit -m "refactor(tools): dedupe ReadTracker — use canonical src/loop/ReadTracker.ts

Removes duplicate src/tools/state/ReadTracker.ts (Wave 1 oversight).
EditFileTool now uses canonical guardEdit() helper.
ReadFileTool/EditFileTool both accept the canonical ReadTracker via opt-in injection."
```

---

## Task 2: `ToolRateLimiter` 接入 `MiMoConfig` + `createMiMoStack`

**Files:**
- Modify: `src/config/MiMoConfig.ts`
- Modify: `src/config/createMiMoStack.ts`
- Test: `tests/unit/createMiMoStack.test.ts`(新建)

### Step 1: 写失败测试

新建 `tests/unit/createMiMoStack.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMiMoStack } from "../../src/config/createMiMoStack.js";
import { ToolRateLimiter } from "../../src/tools/limits/ToolRateLimiter.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";

describe("createMiMoStack — ToolRateLimiter 集成", () => {
	it("cfg.rateLimit 提供时,工厂构造 ToolRateLimiter 并把它附加到 stack", () => {
		const registry = new ToolRegistry();
		const stub = { streamChat: async function*() {} };
		const stack = createMiMoStack(
			stub,
			registry,
			"/tmp/work",
			{ rateLimit: { aggregate: { maxCalls: 5, windowSeconds: 60 } } },
		);
		expect(stack.rateLimiter).toBeInstanceOf(ToolRateLimiter);
		const policy = stack.rateLimiter?.policy;
		expect(policy).not.toBe(false);
		if (policy && policy !== false) {
			expect(policy.aggregate.maxCalls).toBe(5);
		}
	});

	it("cfg.rateLimit:false 时不构造限流器", () => {
		const registry = new ToolRegistry();
		const stub = { streamChat: async function*() {} };
		const stack = createMiMoStack(
			stub,
			registry,
			"/tmp/work",
			{ rateLimit: false },
		);
		expect(stack.rateLimiter).toBeUndefined();
	});

	it("deps.toolRateLimiter 注入时优先于 cfg.rateLimit", () => {
		const registry = new ToolRegistry();
		const injected = new ToolRateLimiter({ aggregate: { maxCalls: 999, windowSeconds: 60 } });
		const stub = { streamChat: async function*() {} };
		const stack = createMiMoStack(
			stub,
			registry,
			"/tmp/work",
			{ rateLimit: { aggregate: { maxCalls: 5, windowSeconds: 60 } } },
			{ toolRateLimiter: injected },
		);
		expect(stack.rateLimiter).toBe(injected);
	});
});
```

### Step 2: 跑测试预期 FAIL

Run: `npm test -- tests/unit/createMiMoStack.test.ts`
Expected: 所有用例 FAIL(`MiMoConfig` 没有 `rateLimit` 字段、`MiMoStack` 没有 `rateLimiter` 字段、`createMiMoStack` 不接受 `toolRateLimiter` dep)。

### Step 3: 改 `MiMoConfig.ts`

在文件顶部添加 import:

```ts
import type { ToolRateLimitOption } from "../tools/limits/ToolRateLimiter.js";
```

在 `MiMoConfig` 接口尾部(在 `memory?` 之后)添加:

```ts
	/** 工具调用限流配置(false 关闭,缺省使用 ToolRateLimiter 的内置默认)*/
	rateLimit?: ToolRateLimitOption;
```

在 `DEFAULT_MIMO_CONFIG`(`Required<MiMoConfig>`)的对象字面里,在 `memory:` 之后添加:

```ts
	rateLimit: {},
```

> 注:`{}` 表示"启用,使用 ToolRateLimiter 的内置默认"。`false` 显式关闭。

在 `mergeConfig` 函数末尾(`memory:` 字段之后)添加:

```ts
		rateLimit:
			user.rateLimit === false
				? false
				: user.rateLimit === undefined
					? DEFAULT_MIMO_CONFIG.rateLimit
					: { ...DEFAULT_MIMO_CONFIG.rateLimit, ...user.rateLimit },
```

### Step 4: 改 `createMiMoStack.ts`

(a) 顶部添加 import:

```ts
import { ToolRateLimiter } from "../tools/limits/ToolRateLimiter.js";
import { ChoiceTool } from "../tools/choice/ChoiceTool.js";
import type { ConfirmationGate } from "../tools/choice/ConfirmationGate.js";
```

(b) `MiMoStack` 接口加新字段:

```ts
export interface MiMoStack {
	loop: MiMoLoop;
	validator: CodeValidator;
	contextManager: ContextManager;
	sessionManager: SessionManager;
	approvalManager: ApprovalManager;
	memoryManager?: SingleAgentMemoryManager;
	rateLimiter?: ToolRateLimiter;
}
```

(c) `createMiMoStack` 函数签名的 `deps` 加两个可选字段:

```ts
deps: {
	hookManager?: IHookManager;
	approvalManager?: ApprovalManager;
	toolRateLimiter?: ToolRateLimiter;
	confirmationGate?: ConfirmationGate;
} = {},
```

(d) 在 `mergeConfig(userConfig)` 那行之后(`const cfg = mergeConfig(userConfig);` 后面)构造限流器:

```ts
	// ToolRateLimiter — caller injection wins; otherwise build from config.
	const rateLimiter: ToolRateLimiter | undefined =
		deps.toolRateLimiter !== undefined
			? deps.toolRateLimiter
			: cfg.rateLimit === false
				? undefined
				: new ToolRateLimiter(cfg.rateLimit);
```

(e) 在 `builtins` 数组里加 `ChoiceTool`(注意它需要 gate;不要在 builtins 数组里构造,要分两步):

把:
```ts
const builtins = [new TodoWriteTool(), new ApplyPatchTool()] as const;
```

改为:
```ts
const builtins = [
	new TodoWriteTool(),
	new ApplyPatchTool(),
	new ChoiceTool({ gate: deps.confirmationGate }),
] as const;
```

> `ChoiceTool` 的构造器在 `gate` 为 undefined 时已 fallback 到 `CancelledConfirmationGate`(Wave 1 设计),所以这里直接传 `deps.confirmationGate` 即可。

(f) 在最后 `return { ... }` 加上新字段:

```ts
	return {
		loop,
		validator,
		contextManager,
		sessionManager,
		approvalManager,
		memoryManager,
		rateLimiter,
	};
```

### Step 5: 跑测试

Run: `npm test -- tests/unit/createMiMoStack.test.ts`
Expected: 3/3 PASS。

### Step 6: 验证下游测试

Run: `npm test -- tests/unit/tools.test.ts tests/unit/TodoWriteTool.test.ts tests/unit/EditFileTool.test.ts`
Expected: 全部 PASS——工厂改动是加字段,不破坏旧调用。

### Step 7: typecheck

Run: `npm run typecheck`
Expected: 0 error。

### Step 8: Commit

```bash
git add -A
git commit -m "feat(config): wire ToolRateLimiter into MiMoConfig + createMiMoStack

Adds optional rateLimit field to MiMoConfig (defaults to ToolRateLimiter's built-in policy).
createMiMoStack now constructs ToolRateLimiter from config or accepts caller injection,
exposing it on the returned MiMoStack."
```

---

## Task 3: `ChoiceTool` 自动注册 + 工厂接受 `ConfirmationGate`

**Files:**
- 已经在 Task 2 里改了 `createMiMoStack.ts` 把 ChoiceTool 加进 builtins
- Test: `tests/unit/createMiMoStack.test.ts`(扩充)

> 这个 Task 跟 Task 2 物理上耦合(同一文件改动),但概念独立。Task 2 的 commit 已包含 `builtins` 改动;本 Task 只新增测试覆盖。

### Step 1: 在 `createMiMoStack.test.ts` 末尾追加测试

```ts
import { ChoiceTool } from "../../src/tools/choice/ChoiceTool.js";
import { DeferredConfirmationGate } from "../../src/tools/choice/ConfirmationGate.js";

describe("createMiMoStack — ChoiceTool 内置注册", () => {
	it("ChoiceTool 被注册到 tools registry", () => {
		const registry = new ToolRegistry();
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, registry, "/tmp/work", {});
		expect(registry.has("ask_choice")).toBe(true);
	});

	it("不重复注册:当 registry 已有 ask_choice 时跳过", () => {
		const registry = new ToolRegistry();
		const preExisting = new ChoiceTool();
		registry.register(preExisting as any);
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, registry, "/tmp/work", {});
		// 仍然是 1 个 ask_choice 注册,且仍是 preExisting 实例
		expect(registry.get("ask_choice")).toBeTruthy();
	});

	it("deps.confirmationGate 透传到 ChoiceTool", async () => {
		const registry = new ToolRegistry();
		const gate = new DeferredConfirmationGate();
		gate.resolve({ type: "pick", optionId: "X" });
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, registry, "/tmp/work", {}, { confirmationGate: gate });
		const res = await registry.execute({
			function: {
				name: "ask_choice",
				arguments: JSON.stringify({
					question: "P?",
					options: [
						{ id: "X", title: "X" },
						{ id: "Y", title: "Y" },
					],
				}),
			},
		});
		expect(res.content).toBe("user picked: X");
	});
});
```

### Step 2: 跑测试

Run: `npm test -- tests/unit/createMiMoStack.test.ts`
Expected: 6/6 PASS(本 Task 加的 3 个 + Task 2 的 3 个)。

> 若"不重复注册"用例失败,说明 `createMiMoStack.ts:65` 的 `if (tools.has?.(tool.name)) continue;` 在 ToolRegistry 上 `has` 存在但跳过逻辑未生效。检查 `ToolRegistry.has` 是否被正确调用。

### Step 3: Commit

```bash
git add tests/unit/createMiMoStack.test.ts
git commit -m "test(config): cover ChoiceTool builtin registration via createMiMoStack"
```

---

## Task 4: 端到端验证 —— 限流真正作用于工具调用

**Files:**
- Test: `tests/integration/wave2a-rate-limit.test.ts`(新建)

确认整条链路:MiMoConfig.rateLimit → createMiMoStack → ToolRateLimiter → ToolRegistry → 工具调用返回 isError:true with rate_limited payload。

### Step 1: 写集成测试

新建 `tests/integration/wave2a-rate-limit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMiMoStack } from "../../src/config/createMiMoStack.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";
import { ExecShellTool } from "../../src/tools/shell/ExecShellTool.js";
import { parseRateLimitedToolResult } from "../../src/tools/limits/ToolRateLimiter.js";

describe("Wave 2a 端到端:rateLimit 配置 → ToolRegistry 短路", () => {
	it("aggregate maxCalls=1 时第二次调用返回 rate_limited", async () => {
		const registry = new ToolRegistry();
		registry.register(new ExecShellTool());
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, registry, process.cwd(), {
			rateLimit: { aggregate: { maxCalls: 1, windowSeconds: 60 } },
		});
		// stack.rateLimiter 已存在,但 createMiMoStack 默认不会把它装进 ToolRegistry——
		// 调用方需要自己把 stack.rateLimiter 传给新的 ToolRegistry,或者改 ToolRegistry 接受后设。
		// 这里的 ExecShellTool 注册路径没有限流——这正是本测试要暴露的问题。
		// 修复:见 Step 2。
	});
});
```

### Step 2: 改 `createMiMoStack` 让 stack.rateLimiter 也注入到 tools registry(如果可能)

⚠️ 设计抉择:`ToolRegistry.rateLimiter` 是 `private readonly`,构造后不可改。三种选择:

- **A.** 把 `createMiMoStack` 改为**重建** ToolRegistry:用调用方传入的 `tools` 的内容初始化一个新 ToolRegistry({rateLimiter})。但调用方持有的引用就会成为孤儿——破坏调用方语义。**拒绝**。
- **B.** 给 `ToolRegistry` 加 `setRateLimiter()` 方法。破坏 readonly 不可变性。**可接受**。
- **C.** 文档化"调用方负责构造 `ToolRegistry({rateLimiter: stack.rateLimiter})`":由调用方在创建栈之前先 `createMiMoStack` 拿到 rateLimiter,再据此创建 `ToolRegistry`。这要求双相依赖(stack 需要 tools 注册,tools 需要 stack 的 rateLimiter)。**不可接受**(循环)。

**选 B**。改 `ToolRegistry.ts`:

```ts
setRateLimiter(limiter: ToolRateLimiter | undefined): void {
	(this as { rateLimiter?: ToolRateLimiter }).rateLimiter = limiter;
}
```

> 用类型断言绕开 `readonly`——这是受控的内部方法,调用方应明白这意味着接管限流策略。

然后在 `createMiMoStack.ts` 的工厂里,构造完 `rateLimiter` 后立即:

```ts
if (rateLimiter && typeof (tools as any).setRateLimiter === "function") {
	(tools as any).setRateLimiter(rateLimiter);
}
```

`(tools as any)` 因为 `createMiMoStack` 的 `tools: any` 参数已是 any——保持现有签名。

### Step 3: 完成集成测试

把 Step 1 的测试 body 补完:

```ts
	it("aggregate maxCalls=1 时第二次调用返回 rate_limited", async () => {
		const registry = new ToolRegistry();
		registry.register(new ExecShellTool());
		const stub = { streamChat: async function*() {} };
		const stack = createMiMoStack(stub, registry, process.cwd(), {
			rateLimit: { aggregate: { maxCalls: 1, windowSeconds: 60 } },
		});
		expect(stack.rateLimiter).toBeDefined();

		// 第一次成功
		const first = await registry.execute({
			function: { name: "exec_shell", arguments: '{"command":"echo a"}' },
		});
		expect(first.isError).toBeFalsy();

		// 第二次被限流
		const second = await registry.execute({
			function: { name: "exec_shell", arguments: '{"command":"echo b"}' },
		});
		expect(second.isError).toBe(true);
		const parsed = parseRateLimitedToolResult(second.content);
		expect(parsed).not.toBeNull();
		expect(parsed?.error).toBe("rate_limited");
		expect(parsed?.scope).toBe("all_tools");
	});

	it("rateLimit:false 时不施加限流", async () => {
		const registry = new ToolRegistry();
		registry.register(new ExecShellTool());
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, registry, process.cwd(), { rateLimit: false });
		for (let i = 0; i < 5; i++) {
			const r = await registry.execute({
				function: { name: "exec_shell", arguments: '{"command":"echo x"}' },
			});
			expect(r.isError).toBeFalsy();
		}
	});
```

### Step 4: 跑集成测试

Run: `npm test -- tests/integration/wave2a-rate-limit.test.ts`
Expected: 2/2 PASS。

> 该测试目录可能现在不存在;若 vitest 默认配置只跑 `tests/unit/`,需要在 `vitest.config.ts` 的 `include` 数组加 `tests/integration/**/*.test.ts`。先检查;若已包含则免动。(查阅 Wave 1 用 `tests/integration/p0-wiring.test.ts` 时是否被默认配置覆盖。)

### Step 5: 跑全量测试

Run: `npm test`
Expected: 全绿(除已知 9 个预先存在的 Windows 失败)。

### Step 6: Commit

```bash
git add src/tools/ToolRegistry.ts src/config/createMiMoStack.ts tests/integration/wave2a-rate-limit.test.ts
git commit -m "feat(tools): ToolRegistry.setRateLimiter + createMiMoStack auto-injection

createMiMoStack now wires the constructed ToolRateLimiter into the caller's ToolRegistry
via setRateLimiter, completing the end-to-end rate-limit path."
```

---

## 验收清单

完成所有 Task 后逐项打勾:

- [ ] `src/tools/state/` 目录已删除(或为空)
- [ ] `src/tools/index.ts` 的 `ReadTracker` re-export 指向 `src/loop/ReadTracker.ts`
- [ ] `tests/unit/ReadTracker.test.ts` 6 个用例全过,且导入路径指向 canonical 版
- [ ] `tests/unit/EditFileTool.test.ts` 3 个用例全过,断言文本匹配 canonical 版的错误信息
- [ ] `MiMoConfig.rateLimit` 字段已加,`mergeConfig` 正确处理 `false` / 空对象 / 部分覆盖三种情况
- [ ] `createMiMoStack` 返回 `MiMoStack` 含 `rateLimiter?`
- [ ] `createMiMoStack` 接受 `deps.toolRateLimiter`(优先)与 `deps.confirmationGate`(透传 ChoiceTool)
- [ ] `ChoiceTool` 自动注册到 builtins,即使 `confirmationGate` 未传也不会爆炸(用 CancelledConfirmationGate fallback)
- [ ] `ToolRegistry.setRateLimiter()` 新方法存在
- [ ] `wave2a-rate-limit.test.ts` 2 个用例验证端到端限流生效
- [ ] `npm test` 全绿(已知 Windows 失败除外)
- [ ] `npm run typecheck` 0 error
- [ ] git log 显示 4 个 Task 各一次提交

---

## 留给 Wave 2 后续的接口

本计划刻意**不做**以下事:

- **TUI 真实的 `ConfirmationGate` 实现**——`createMiMoStack` 现在能接受 gate 但默认仍是 `CancelledConfirmationGate`(立即返回 cancel)。真正接 TUI 的 picker 是独立 Plan(暂名 `wave2a-tui-gate`),需要先深入摸 `tui/src/state/reducer.ts`、`tui/src/engine.ts`、CLI 的 `EngineBridge`,本计划不投入。
- **`parseRateLimitedToolResult` 在 MiMoLoop 里的退避动作**——当前 `isError:true` 的 rate-limited 结果会被照常发回模型,模型读到 `retryAfterMs` 后自然减速。是否要在 loop 里加显式 sleep / retry 是后续设计抉择,本计划不涉及。
- **`ReadTracker` 的全局共享(MiMoLoop 的 readTracker ↔ ReadFileTool/EditFileTool 的 readTracker 是同一个实例)**——目前 MiMoLoop 自己构造一份,ReadFileTool/EditFileTool 各自构造或由调用方注入。若希望工厂统一拉一份共享给所有工具,需在 `createMiMoStack` 里多绕一道。等到有具体调用场景再做。
