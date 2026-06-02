# Wave 1 — DeepSeek-Reasonix 工具集成计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 DeepSeek-Reasonix 工具集中的四项"低风险、高价值"能力移植到 `src/tools/`:`ToolRateLimiter`、`ReadTracker`、增强版 `TodoWriteTool`、新增 `ChoiceTool`。完成后这四块在单元测试下绿、并以可选方式接入既有 `ToolRegistry` / `ReadFileTool` / `EditFileTool`,不破坏旧调用。

**Architecture:**
- 捐赠方用"函数 + 元数据 + `fn:`回调"注册;接收方用"类实现 `Tool` 接口、`execute() => Promise<string>`"。所有移植都改造成类。
- 跨切关注点(限流、读追踪)做成**可选依赖注入**:`ToolRegistry` 接收可选 `rateLimiter`、`ReadFileTool`/`EditFileTool` 接收可选 `ReadTracker`。未注入时行为完全不变,旧测试通过。
- `ChoiceTool` 依赖 TUI 回环(用户选择阻塞返回)。本波只引入 `ConfirmationGate` 接口 + 默认 `cancelled` 哑实现 + 测试用 `DeferredConfirmationGate`,真正的 TUI 接线作为 Wave 2 议题留出。

**Tech Stack:** TypeScript (Node 22, ESM, `.js` import suffix)、vitest、biome。无新增运行时依赖。

---

## 文件结构

### 新增

| 路径 | 责任 |
|---|---|
| `src/tools/limits/ToolRateLimiter.ts` | 滑动窗口限流器(聚合 + 按工具桶)、`consume(name)` 返回 allowed/限流结构体 |
| `src/tools/limits/index.ts` | re-export |
| `src/tools/state/ReadTracker.ts` | 会话级"已读"集合,跨平台路径归一化 |
| `src/tools/state/index.ts` | re-export |
| `src/tools/choice/ConfirmationGate.ts` | `ConfirmationGate` 接口 + `DeferredConfirmationGate`(测试) + `CancelledConfirmationGate`(默认) + `ChoiceVerdict` 类型 |
| `src/tools/choice/ChoiceTool.ts` | `ask_choice` 工具类 |
| `src/tools/choice/index.ts` | re-export |
| `tests/unit/ToolRateLimiter.test.ts` | 限流器单元测试 |
| `tests/unit/ReadTracker.test.ts` | 读追踪单元测试 |
| `tests/unit/ChoiceTool.test.ts` | ChoiceTool 单元测试 |
| `tests/unit/TodoWriteTool.test.ts` | 增强版 TodoWriteTool 单元测试 |

### 修改

| 路径 | 改动 |
|---|---|
| `src/tools/todo/TodoWriteTool.ts` | `TodoItem` 加 `activeForm` 必填、严格校验抛错、渲染使用 activeForm |
| `src/tools/todo/index.ts` | 类型 re-export 不变(`TodoItem` 已经过其转出) |
| `src/tools/ToolRegistry.ts` | 构造函数可选 `{ rateLimiter?: ToolRateLimiter }`、`execute()` 在派发前 `consume()` |
| `src/tools/filesystem/ReadFileTool.ts` | 构造函数可选 `{ readTracker?: ReadTracker }`、成功读取后 `markRead()` |
| `src/tools/filesystem/EditFileTool.ts` | 构造函数可选 `{ readTracker?: ReadTracker }`、未读时返回结构化错误 |
| `src/tools/index.ts` | 导出新模块 |
| `tests/unit/tools.test.ts` | 不动(`TodoItem` 改动可能波及,需在 Task 5 验证) |

---

## Task 1: ToolRateLimiter — 移植 + 单元测试

**Files:**
- Create: `src/tools/limits/ToolRateLimiter.ts`
- Create: `src/tools/limits/index.ts`
- Test: `tests/unit/ToolRateLimiter.test.ts`

- [ ] **Step 1: 创建空目录占位 & 失败测试骨架**

写入 `tests/unit/ToolRateLimiter.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	ToolRateLimiter,
	normalizeToolRateLimitConfig,
	DEFAULT_TOOL_RATE_LIMIT,
} from "../../src/tools/limits/ToolRateLimiter.js";

describe("ToolRateLimiter", () => {
	it("默认配置归一化", () => {
		const cfg = normalizeToolRateLimitConfig({});
		expect(cfg).not.toBe(false);
		if (cfg === false) return;
		expect(cfg.aggregate).toEqual(DEFAULT_TOOL_RATE_LIMIT.aggregate);
	});

	it("enabled:false 时彻底禁用", () => {
		const limiter = new ToolRateLimiter({ enabled: false });
		expect(limiter.consume("any")).toEqual({ allowed: true });
	});
});
```

- [ ] **Step 2: 运行测试预期失败**

Run: `pnpm exec vitest run tests/unit/ToolRateLimiter.test.ts` (或 `npm test -- tests/unit/ToolRateLimiter.test.ts`)
Expected: FAIL,`Cannot find module ... ToolRateLimiter.js`。

- [ ] **Step 3: 移植源文件**

写入 `src/tools/limits/ToolRateLimiter.ts`,直接基于捐赠方 `tmp/DeepSeek-Reasonix-main/src/tools/rate-limit.ts` 内容(整文件可复制),只删除文件顶部注释中的项目名引用即可。代码主体:

```ts
/** 滑动窗口工具限流:聚合桶 + 可选按工具桶。源自 DeepSeek-Reasonix rate-limit。 */

export interface ToolRateLimitBucketConfig {
	maxCalls?: number;
	windowSeconds?: number;
}

export interface ToolRateLimitConfig {
	enabled?: boolean;
	aggregate?: ToolRateLimitBucketConfig;
	tools?: Record<string, false | ToolRateLimitBucketConfig>;
}

export interface NormalizedToolRateLimitBucket {
	maxCalls: number;
	windowSeconds: number;
}

export interface NormalizedToolRateLimitConfig {
	aggregate: NormalizedToolRateLimitBucket;
	tools: Record<string, false | NormalizedToolRateLimitBucket>;
}

export interface RateLimitedToolResult {
	error: "rate_limited";
	tool: string;
	scope: string;
	limit: number;
	windowSeconds: number;
	retryAfterMs: number;
	message: string;
}

export type ToolRateLimitDecision =
	| { allowed: true }
	| { allowed: false; result: RateLimitedToolResult };

export const DEFAULT_TOOL_RATE_LIMIT: NormalizedToolRateLimitConfig = {
	aggregate: { maxCalls: 200, windowSeconds: 60 },
	tools: {
		exec_shell: { maxCalls: 60, windowSeconds: 60 },
	},
};

export type ToolRateLimitOption = false | ToolRateLimitConfig;
type Clock = () => number;

export class ToolRateLimiter {
	private readonly config: false | NormalizedToolRateLimitConfig;
	private readonly clock: Clock;
	private readonly aggregate: number[] = [];
	private readonly tools = new Map<string, number[]>();

	constructor(config: ToolRateLimitOption | undefined = {}, clock: Clock = () => Date.now()) {
		this.config = normalizeToolRateLimitConfig(config);
		this.clock = clock;
	}

	get policy(): false | NormalizedToolRateLimitConfig {
		return this.config;
	}

	consume(tool: string): ToolRateLimitDecision {
		if (this.config === false) return { allowed: true };
		const now = this.clock();
		const toolBucket = this.config.tools[tool];
		if (toolBucket !== false && toolBucket !== undefined) {
			const timestamps = this.timestampsFor(tool);
			const blocked = inspectBucket(tool, timestamps, toolBucket, now);
			if (blocked) return { allowed: false, result: blocked };
		}
		const aggBlocked = inspectBucket(tool, this.aggregate, this.config.aggregate, now, "all_tools");
		if (aggBlocked) return { allowed: false, result: aggBlocked };
		this.aggregate.push(now);
		if (toolBucket !== false && toolBucket !== undefined) this.timestampsFor(tool).push(now);
		return { allowed: true };
	}

	private timestampsFor(tool: string): number[] {
		const existing = this.tools.get(tool);
		if (existing) return existing;
		const created: number[] = [];
		this.tools.set(tool, created);
		return created;
	}
}

export function normalizeToolRateLimitConfig(
	config: ToolRateLimitOption | undefined,
): false | NormalizedToolRateLimitConfig {
	if (config === false || config?.enabled === false) return false;
	const aggregate = normalizeBucket(config?.aggregate, DEFAULT_TOOL_RATE_LIMIT.aggregate);
	const tools: Record<string, false | NormalizedToolRateLimitBucket> = {
		...DEFAULT_TOOL_RATE_LIMIT.tools,
	};
	for (const [name, value] of Object.entries(config?.tools ?? {})) {
		if (value === false) {
			tools[name] = false;
			continue;
		}
		const fallback = DEFAULT_TOOL_RATE_LIMIT.tools[name];
		tools[name] = normalizeBucket(
			value,
			fallback === false || fallback === undefined ? DEFAULT_TOOL_RATE_LIMIT.aggregate : fallback,
		);
	}
	return { aggregate, tools };
}

export function parseRateLimitedToolResult(result: string): RateLimitedToolResult | null {
	try {
		const parsed = JSON.parse(result) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const value = parsed as Partial<RateLimitedToolResult>;
		if (value.error !== "rate_limited") return null;
		if (typeof value.tool !== "string" || typeof value.scope !== "string") return null;
		if (typeof value.limit !== "number" || typeof value.windowSeconds !== "number") return null;
		if (typeof value.retryAfterMs !== "number" || typeof value.message !== "string") return null;
		return value as RateLimitedToolResult;
	} catch {
		return null;
	}
}

function normalizeBucket(
	raw: ToolRateLimitBucketConfig | undefined,
	fallback: NormalizedToolRateLimitBucket,
): NormalizedToolRateLimitBucket {
	return {
		maxCalls: positiveInteger(raw?.maxCalls) ?? fallback.maxCalls,
		windowSeconds: positiveInteger(raw?.windowSeconds) ?? fallback.windowSeconds,
	};
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function inspectBucket(
	tool: string,
	timestamps: number[],
	bucket: NormalizedToolRateLimitBucket,
	now: number,
	scope = tool,
): RateLimitedToolResult | null {
	const windowMs = bucket.windowSeconds * 1_000;
	while (timestamps.length > 0 && now - timestamps[0]! >= windowMs) timestamps.shift();
	if (timestamps.length < bucket.maxCalls) return null;
	const retryAfterMs = Math.max(0, timestamps[0]! + windowMs - now);
	return {
		error: "rate_limited",
		tool,
		scope,
		limit: bucket.maxCalls,
		windowSeconds: bucket.windowSeconds,
		retryAfterMs,
		message: `${scope} rate-limited: ${bucket.maxCalls} calls / ${bucket.windowSeconds}s. Wait ${formatWait(retryAfterMs)} or summarize what you know.`,
	};
}

function formatWait(ms: number): string {
	const seconds = ms / 1_000;
	return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
}
```

注意:把捐赠方默认 `run_command` / `run_background` 改成接收方的工具名 `exec_shell`。

- [ ] **Step 4: 写 index.ts**

写入 `src/tools/limits/index.ts`:

```ts
export {
	ToolRateLimiter,
	normalizeToolRateLimitConfig,
	parseRateLimitedToolResult,
	DEFAULT_TOOL_RATE_LIMIT,
} from "./ToolRateLimiter.js";
export type {
	ToolRateLimitConfig,
	ToolRateLimitBucketConfig,
	ToolRateLimitOption,
	NormalizedToolRateLimitConfig,
	NormalizedToolRateLimitBucket,
	ToolRateLimitDecision,
	RateLimitedToolResult,
} from "./ToolRateLimiter.js";
```

- [ ] **Step 5: 运行 Step 1 测试**

Run: `npm test -- tests/unit/ToolRateLimiter.test.ts`
Expected: PASS (2/2)。

- [ ] **Step 6: 追加滑动窗口测试**

向同文件追加:

```ts
describe("ToolRateLimiter 滑动窗口", () => {
	it("达到 maxCalls 后拒绝,retryAfterMs > 0", () => {
		let t = 1_000_000;
		const limiter = new ToolRateLimiter(
			{ aggregate: { maxCalls: 3, windowSeconds: 10 } },
			() => t,
		);
		expect(limiter.consume("a").allowed).toBe(true);
		expect(limiter.consume("a").allowed).toBe(true);
		expect(limiter.consume("a").allowed).toBe(true);
		const blocked = limiter.consume("a");
		expect(blocked.allowed).toBe(false);
		if (blocked.allowed) return;
		expect(blocked.result.scope).toBe("all_tools");
		expect(blocked.result.retryAfterMs).toBeGreaterThan(0);
	});

	it("窗口滑过后旧时间戳被丢弃", () => {
		let t = 0;
		const limiter = new ToolRateLimiter(
			{ aggregate: { maxCalls: 2, windowSeconds: 1 } },
			() => t,
		);
		limiter.consume("x");
		limiter.consume("x");
		expect(limiter.consume("x").allowed).toBe(false);
		t += 1_500;
		expect(limiter.consume("x").allowed).toBe(true);
	});

	it("per-tool 桶独立限制", () => {
		let t = 0;
		const limiter = new ToolRateLimiter(
			{
				aggregate: { maxCalls: 100, windowSeconds: 60 },
				tools: { foo: { maxCalls: 1, windowSeconds: 60 } },
			},
			() => t,
		);
		expect(limiter.consume("foo").allowed).toBe(true);
		const blocked = limiter.consume("foo");
		expect(blocked.allowed).toBe(false);
		if (!blocked.allowed) expect(blocked.result.scope).toBe("foo");
		expect(limiter.consume("bar").allowed).toBe(true);
	});

	it("tools[name]=false 禁用该工具的桶", () => {
		const limiter = new ToolRateLimiter({
			tools: { exec_shell: false },
		});
		for (let i = 0; i < 100; i++) {
			expect(limiter.consume("exec_shell").allowed).toBe(true);
		}
	});
});
```

- [ ] **Step 7: 运行全部测试**

Run: `npm test -- tests/unit/ToolRateLimiter.test.ts`
Expected: PASS (全部用例)。

- [ ] **Step 8: 提交**

```bash
git add src/tools/limits tests/unit/ToolRateLimiter.test.ts
git commit -m "feat(tools): add ToolRateLimiter (sliding window per-tool + aggregate)"
```

---

## Task 2: 把 ToolRateLimiter 接入 ToolRegistry

**Files:**
- Modify: `src/tools/ToolRegistry.ts`
- Test: `tests/unit/tools.test.ts` (在 `describe("ToolRegistry", ...)` 内追加用例)

- [ ] **Step 1: 写失败测试**

在 `tests/unit/tools.test.ts` 顶部加入 import:

```ts
import { ToolRateLimiter } from "../../src/tools/limits/ToolRateLimiter.js";
```

在 `describe("ToolRegistry", ...)` 块末尾加用例:

```ts
it("rate limiter 短路时返回限流结构体且不调用工具", async () => {
	const limiter = new ToolRateLimiter({
		aggregate: { maxCalls: 1, windowSeconds: 60 },
	});
	const registry = new ToolRegistry({ rateLimiter: limiter });
	registry.register(new ExecShellTool());
	const ok = await registry.execute({
		function: { name: "exec_shell", arguments: '{"command":"echo a"}' },
	});
	expect(ok.isError).toBeFalsy();
	const blocked = await registry.execute({
		function: { name: "exec_shell", arguments: '{"command":"echo b"}' },
	});
	expect(blocked.isError).toBe(true);
	expect(blocked.content).toContain("rate_limited");
});
```

- [ ] **Step 2: 运行测试预期失败**

Run: `npm test -- tests/unit/tools.test.ts`
Expected: FAIL,`ToolRegistry` 构造不接受参数或者第二个调用仍然成功。

- [ ] **Step 3: 修改 ToolRegistry**

编辑 `src/tools/ToolRegistry.ts`:

(a) 在顶部 import 后加:

```ts
import type { ToolRateLimiter } from "./limits/ToolRateLimiter.js";
```

(b) 在 class 体里加构造与字段:

```ts
private readonly rateLimiter?: ToolRateLimiter;

constructor(options: { rateLimiter?: ToolRateLimiter } = {}) {
	this.rateLimiter = options.rateLimiter;
}
```

(c) 在 `execute(...)` 中,JSON.parse 成功之后、调用 `tool.execute` 之前插入:

```ts
if (this.rateLimiter) {
	const decision = this.rateLimiter.consume(toolCall.function.name);
	if (!decision.allowed) {
		return {
			content: JSON.stringify(decision.result),
			isError: true,
		};
	}
}
```

- [ ] **Step 4: 运行测试**

Run: `npm test -- tests/unit/tools.test.ts`
Expected: PASS(包括所有旧 ToolRegistry 用例:它们都用 `new ToolRegistry()` 不带参数,默认 `rateLimiter` 为 undefined,无短路,行为不变)。

- [ ] **Step 5: 跑一次 typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add src/tools/ToolRegistry.ts tests/unit/tools.test.ts
git commit -m "feat(tools): wire optional ToolRateLimiter into ToolRegistry.execute"
```

---

## Task 3: ReadTracker — 移植 + 单元测试

**Files:**
- Create: `src/tools/state/ReadTracker.ts`
- Create: `src/tools/state/index.ts`
- Test: `tests/unit/ReadTracker.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/unit/ReadTracker.test.ts`:

```ts
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ReadTracker } from "../../src/tools/state/ReadTracker.js";

describe("ReadTracker", () => {
	it("初始未读", () => {
		const t = new ReadTracker();
		expect(t.hasRead("/tmp/foo")).toBe(false);
		expect(t.size).toBe(0);
	});

	it("markRead 后 hasRead 返回 true", () => {
		const t = new ReadTracker();
		t.markRead("/tmp/foo");
		expect(t.hasRead("/tmp/foo")).toBe(true);
		expect(t.size).toBe(1);
	});

	it("路径归一化:相对/绝对等价", () => {
		const t = new ReadTracker();
		const abs = path.resolve("a/b/c.txt");
		t.markRead(abs);
		expect(t.hasRead(path.resolve("a/b/c.txt"))).toBe(true);
	});

	it("reset 清空", () => {
		const t = new ReadTracker();
		t.markRead("/x");
		t.reset();
		expect(t.size).toBe(0);
		expect(t.hasRead("/x")).toBe(false);
	});
});
```

- [ ] **Step 2: 运行测试预期失败**

Run: `npm test -- tests/unit/ReadTracker.test.ts`
Expected: FAIL,模块未找到。

- [ ] **Step 3: 写实现**

`src/tools/state/ReadTracker.ts`(基于捐赠方 `read-tracker.ts` 整体复制,文档串改为中文不变也可):

```ts
import * as pathMod from "node:path";

/** 追踪本会话内已字节级见过的文件;edit_file 派发前查询,确保 SEARCH 文本与磁盘字节一致。 */
export class ReadTracker {
	private readonly _seen = new Set<string>();

	private static norm(abs: string): string {
		const resolved = pathMod.resolve(abs);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	}

	markRead(abs: string): void {
		this._seen.add(ReadTracker.norm(abs));
	}

	hasRead(abs: string): boolean {
		return this._seen.has(ReadTracker.norm(abs));
	}

	reset(): void {
		this._seen.clear();
	}

	get size(): number {
		return this._seen.size;
	}
}
```

- [ ] **Step 4: 写 index.ts**

`src/tools/state/index.ts`:

```ts
export { ReadTracker } from "./ReadTracker.js";
```

- [ ] **Step 5: 运行测试**

Run: `npm test -- tests/unit/ReadTracker.test.ts`
Expected: PASS (4/4)。

- [ ] **Step 6: 提交**

```bash
git add src/tools/state tests/unit/ReadTracker.test.ts
git commit -m "feat(tools): add ReadTracker (session-scoped file-read membership)"
```

---

## Task 4: 把 ReadTracker 接入 ReadFileTool / EditFileTool

**Files:**
- Modify: `src/tools/filesystem/ReadFileTool.ts`
- Modify: `src/tools/filesystem/EditFileTool.ts`
- Test: `tests/unit/ReadTracker.test.ts` (追加集成用例) **或**新建 `tests/unit/EditFileTool.test.ts`

- [ ] **Step 1: 写失败测试**

新增 `tests/unit/EditFileTool.test.ts`:

```ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EditFileTool } from "../../src/tools/filesystem/EditFileTool.js";
import { ReadFileTool } from "../../src/tools/filesystem/ReadFileTool.js";
import { ReadTracker } from "../../src/tools/state/ReadTracker.js";

describe("EditFileTool + ReadTracker", () => {
	let dir: string;
	let file: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "minimum-edit-"));
		file = path.join(dir, "a.txt");
		await fs.writeFile(file, "hello world", "utf-8");
	});

	it("未注入 tracker 时旧行为保持(可直接编辑)", async () => {
		const edit = new EditFileTool();
		const out = await edit.execute({
			path: file,
			edits: [{ search: "world", replace: "claude" }],
		});
		expect(out).toContain("edited successfully");
		expect(await fs.readFile(file, "utf-8")).toBe("hello claude");
	});

	it("注入 tracker 但未先读则拒绝编辑", async () => {
		const tracker = new ReadTracker();
		const edit = new EditFileTool({ readTracker: tracker });
		const out = await edit.execute({
			path: file,
			edits: [{ search: "world", replace: "x" }],
		});
		expect(out).toMatch(/must read.*before editing/i);
		expect(await fs.readFile(file, "utf-8")).toBe("hello world");
	});

	it("先 read_file 后 edit 才放行", async () => {
		const tracker = new ReadTracker();
		const read = new ReadFileTool({ readTracker: tracker });
		const edit = new EditFileTool({ readTracker: tracker });
		await read.execute({ path: file });
		const out = await edit.execute({
			path: file,
			edits: [{ search: "world", replace: "claude" }],
		});
		expect(out).toContain("edited successfully");
	});
});
```

- [ ] **Step 2: 运行测试预期失败**

Run: `npm test -- tests/unit/EditFileTool.test.ts`
Expected: FAIL — 工具构造不接受 options。

- [ ] **Step 3: 改 ReadFileTool**

编辑 `src/tools/filesystem/ReadFileTool.ts`,在顶部 import 后加:

```ts
import type { ReadTracker } from "../state/ReadTracker.js";
```

将 `class ReadFileTool {` 主体改为:

```ts
export class ReadFileTool {
	name = "read_file";
	description = "Read the contents of a file";

	private readonly readTracker?: ReadTracker;

	constructor(options: { readTracker?: ReadTracker } = {}) {
		this.readTracker = options.readTracker;
	}

	getDefinition() { /* 保持原样,不动 */ }

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string },
	): Promise<string> {
		const filePath = context?.workingDirectory
			? path.resolve(context.workingDirectory, args.path)
			: path.resolve(args.path);

		try {
			const encoding = args.encoding || "utf-8";
			const content = await fs.readFile(filePath, {
				encoding: encoding as BufferEncoding,
			});
			// 仅在整文件读时标记,startLine/endLine 切片不视为"字节级见过"
			if (args.startLine === undefined && args.endLine === undefined) {
				this.readTracker?.markRead(filePath);
			}
			if (args.startLine !== undefined || args.endLine !== undefined) {
				const lines = content.split("\n");
				const start = (args.startLine || 1) - 1;
				const end = args.endLine || lines.length;
				return lines.slice(start, end).join("\n");
			}
			return content;
		} catch (error: any) {
			return `Error reading file: ${error.message}`;
		}
	}
}
```

- [ ] **Step 4: 改 EditFileTool**

编辑 `src/tools/filesystem/EditFileTool.ts`,加 import:

```ts
import type { ReadTracker } from "../state/ReadTracker.js";
```

将 class 主体改为:

```ts
export class EditFileTool {
	name = "edit_file";
	description = "Edit a file using SEARCH/REPLACE blocks";

	private readonly readTracker?: ReadTracker;

	constructor(options: { readTracker?: ReadTracker } = {}) {
		this.readTracker = options.readTracker;
	}

	getDefinition() { /* 保持原样 */ }

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string },
	): Promise<string> {
		const filePath = context?.workingDirectory
			? path.resolve(context.workingDirectory, args.path)
			: path.resolve(args.path);

		if (this.readTracker && !this.readTracker.hasRead(filePath)) {
			return `Error: must read ${args.path} before editing — call read_file on the full file first so SEARCH text matches on-disk bytes.`;
		}

		try {
			let content = await fs.readFile(filePath, "utf-8");
			for (const edit of args.edits) {
				const index = content.indexOf(edit.search);
				if (index === -1) {
					return `Error: SEARCH text not found: ${edit.search.substring(0, 50)}...`;
				}
				content =
					content.substring(0, index) +
					edit.replace +
					content.substring(index + edit.search.length);
			}
			await fs.writeFile(filePath, content, "utf-8");
			return `File edited successfully: ${args.path}`;
		} catch (error: any) {
			return `Error editing file: ${error.message}`;
		}
	}
}
```

- [ ] **Step 5: 运行新测试**

Run: `npm test -- tests/unit/EditFileTool.test.ts`
Expected: PASS (3/3)。

- [ ] **Step 6: 验证旧 tools.test.ts 仍然过**

Run: `npm test -- tests/unit/tools.test.ts`
Expected: PASS(旧测试用 `new ReadFileTool()` 不带参数,默认 tracker 为 undefined,行为不变)。

- [ ] **Step 7: 提交**

```bash
git add src/tools/filesystem/ReadFileTool.ts src/tools/filesystem/EditFileTool.ts tests/unit/EditFileTool.test.ts
git commit -m "feat(tools): integrate ReadTracker into ReadFileTool/EditFileTool (opt-in)"
```

---

## Task 5: 增强 TodoWriteTool — activeForm + 严格校验

**Files:**
- Modify: `src/tools/todo/TodoWriteTool.ts`
- Test: `tests/unit/TodoWriteTool.test.ts`

⚠️ **破坏性改动:`TodoItem` 接口加 `activeForm: string` 必填字段。** 在 Step 1 前先排查下游消费者。

- [ ] **Step 1: 排查现有 TodoItem 消费者**

Run: `grep -rn "TodoItem\|TodoWriteTool\|getTodos" src/ tests/ --include="*.ts"`
Expected: 列出所有引用。逐个判断:
- 若仅是类型 import 不构造对象 → 无影响
- 若有构造 `{ content, status }` 字面量 → 需补 `activeForm`,记到本任务后续步骤

把发现写在下面这个列表(由执行者填):
```
- [ ] file:line  — 改动说明
```

- [ ] **Step 2: 写新测试**

`tests/unit/TodoWriteTool.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TodoWriteTool } from "../../src/tools/todo/TodoWriteTool.js";

describe("TodoWriteTool (enhanced)", () => {
	it("缺 activeForm 抛/返回错误", async () => {
		const tool = new TodoWriteTool();
		const out = await tool.execute({
			todos: [{ content: "x", status: "pending" }],
		});
		expect(out).toMatch(/activeForm/);
	});

	it("两个 in_progress 拒绝", async () => {
		const tool = new TodoWriteTool();
		const out = await tool.execute({
			todos: [
				{ content: "a", status: "in_progress", activeForm: "Doing a" },
				{ content: "b", status: "in_progress", activeForm: "Doing b" },
			],
		});
		expect(out).toMatch(/in_progress/);
	});

	it("空数组清空", async () => {
		const tool = new TodoWriteTool();
		await tool.execute({
			todos: [{ content: "a", status: "pending", activeForm: "Doing a" }],
		});
		const out = await tool.execute({ todos: [] });
		expect(out).toMatch(/cleared/i);
		expect(tool.getTodos()).toEqual([]);
	});

	it("in_progress 项渲染 activeForm,其它渲染 content", async () => {
		const tool = new TodoWriteTool();
		const out = await tool.execute({
			todos: [
				{ content: "Write tests", status: "completed", activeForm: "Writing tests" },
				{ content: "Run lint", status: "in_progress", activeForm: "Running lint" },
				{ content: "Commit", status: "pending", activeForm: "Committing" },
			],
		});
		expect(out).toContain("[x] Write tests");
		expect(out).toContain("[>] Running lint");
		expect(out).toContain("[ ] Commit");
	});

	it("非法 status 拒绝", async () => {
		const tool = new TodoWriteTool();
		const out = await tool.execute({
			todos: [{ content: "x", status: "wat", activeForm: "Doing x" }],
		});
		expect(out).toMatch(/status/);
	});
});
```

- [ ] **Step 3: 运行测试预期失败**

Run: `npm test -- tests/unit/TodoWriteTool.test.ts`
Expected: 多个失败(旧实现不要求 activeForm,渲染也不用它)。

- [ ] **Step 4: 改写 TodoWriteTool**

把 `src/tools/todo/TodoWriteTool.ts` 整体替换为:

```ts
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	activeForm: string;
}

const MARK = {
	completed: "[x]",
	in_progress: "[>]",
	pending: "[ ]",
} as const;

function validateTodos(raw: unknown): TodoItem[] | string {
	if (!Array.isArray(raw)) return "todo_write: `todos` must be an array";
	const out: TodoItem[] = [];
	let inProgress = 0;
	for (let i = 0; i < raw.length; i++) {
		const e = raw[i];
		if (!e || typeof e !== "object") return `todo_write: todo #${i + 1} must be an object`;
		const obj = e as Record<string, unknown>;
		const content = typeof obj.content === "string" ? obj.content.trim() : "";
		const activeForm = typeof obj.activeForm === "string" ? obj.activeForm.trim() : "";
		const status = obj.status;
		if (!content) return `todo_write: todo #${i + 1} \`content\` must be a non-empty string`;
		if (!activeForm) return `todo_write: todo #${i + 1} \`activeForm\` must be a non-empty string`;
		if (status !== "pending" && status !== "in_progress" && status !== "completed") {
			return `todo_write: todo #${i + 1} \`status\` must be one of pending|in_progress|completed (got ${JSON.stringify(status)})`;
		}
		if (status === "in_progress") {
			inProgress++;
			if (inProgress > 1) {
				return "todo_write: at most one todo may be in_progress at a time — mark the previous one completed first";
			}
		}
		out.push({ content, status, activeForm });
	}
	return out;
}

/**
 * TodoWriteTool — 会话内可见待办,set 语义(每次调用替换整张列表)。
 * 至多一个 in_progress;in_progress 项渲染 activeForm,其它渲染 content。
 */
export class TodoWriteTool {
	name = "todo_write";
	description =
		"In-session task tracker for 3+ step work. Each call REPLACES the entire list (set semantics) — pass the FULL list. Exactly one item may be in_progress at a time; flip to completed the moment that step's done. Pass `[]` to clear.";

	private todos: TodoItem[] = [];

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					todos: {
						type: "array",
						description: "The COMPLETE new todo list. Replaces the previous one. Pass [] to clear.",
						items: {
							type: "object",
							properties: {
								content: {
									type: "string",
									description: "Imperative step description, e.g. \"Add tests for parser\".",
								},
								status: {
									type: "string",
									enum: ["pending", "in_progress", "completed"],
									description: "Current state. Exactly one item may be in_progress.",
								},
								activeForm: {
									type: "string",
									description: "Gerund form shown while in_progress, e.g. \"Adding tests for parser\".",
								},
							},
							required: ["content", "status", "activeForm"],
						},
					},
				},
				required: ["todos"],
			},
		};
	}

	async execute(args: Record<string, any>): Promise<string> {
		const validated = validateTodos(args?.todos);
		if (typeof validated === "string") return `Error: ${validated}`;
		this.todos = validated;
		if (this.todos.length === 0) return "Todo list cleared.";

		let done = 0;
		let active = 0;
		let pending = 0;
		for (const t of this.todos) {
			if (t.status === "completed") done++;
			else if (t.status === "in_progress") active++;
			else pending++;
		}
		const header = `Todos (${done}/${this.todos.length} done · ${active} in progress · ${pending} pending):`;
		const lines = this.todos.map((t) => {
			if (t.status === "in_progress") return `${MARK.in_progress} ${t.activeForm}`;
			return `${MARK[t.status]} ${t.content}`;
		});
		return `${header}\n${lines.join("\n")}`;
	}

	getTodos(): TodoItem[] {
		return [...this.todos];
	}
}
```

- [ ] **Step 5: 修正 Step 1 中发现的下游构造点**

按 Step 1 列表逐个补齐 `activeForm` 字段。

- [ ] **Step 6: 运行测试**

Run: `npm test -- tests/unit/TodoWriteTool.test.ts tests/unit/tools.test.ts`
Expected: PASS。

- [ ] **Step 7: typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 error。

- [ ] **Step 8: 提交**

```bash
git add src/tools/todo/TodoWriteTool.ts tests/unit/TodoWriteTool.test.ts
# 加上 Step 5 触及的下游文件
git commit -m "feat(tools): enhance TodoWriteTool with activeForm and strict validation

BREAKING: TodoItem now requires activeForm field."
```

---

## Task 6: 新增 ChoiceTool + ConfirmationGate

**Files:**
- Create: `src/tools/choice/ConfirmationGate.ts`
- Create: `src/tools/choice/ChoiceTool.ts`
- Create: `src/tools/choice/index.ts`
- Test: `tests/unit/ChoiceTool.test.ts`

- [ ] **Step 1: 写 ConfirmationGate**

`src/tools/choice/ConfirmationGate.ts`:

```ts
export interface ChoiceOption {
	id: string;
	title: string;
	summary?: string;
}

export interface ChoicePayload {
	question: string;
	options: ChoiceOption[];
	allowCustom: boolean;
}

export type ChoiceVerdict =
	| { type: "pick"; optionId: string }
	| { type: "text"; text: string }
	| { type: "cancel" };

export interface ConfirmationGate {
	ask(payload: ChoicePayload): Promise<ChoiceVerdict>;
}

/** 默认 gate:无 TUI 接线时立即返回 cancel,避免阻塞。生产环境应注入真实 gate。 */
export class CancelledConfirmationGate implements ConfirmationGate {
	async ask(_payload: ChoicePayload): Promise<ChoiceVerdict> {
		return { type: "cancel" };
	}
}

/** 测试用 gate:外部先调 resolve(verdict),再触发 tool.execute。 */
export class DeferredConfirmationGate implements ConfirmationGate {
	private pending?: Promise<ChoiceVerdict>;
	private resolver?: (v: ChoiceVerdict) => void;

	ask(_payload: ChoicePayload): Promise<ChoiceVerdict> {
		if (!this.pending) {
			this.pending = new Promise<ChoiceVerdict>((res) => {
				this.resolver = res;
			});
		}
		return this.pending;
	}

	resolve(verdict: ChoiceVerdict): void {
		if (!this.resolver) {
			// 允许 pre-seed:在 ask() 之前先填好
			this.pending = Promise.resolve(verdict);
			return;
		}
		this.resolver(verdict);
		this.resolver = undefined;
	}
}
```

- [ ] **Step 2: 写 ChoiceTool 失败测试**

`tests/unit/ChoiceTool.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ChoiceTool } from "../../src/tools/choice/ChoiceTool.js";
import {
	CancelledConfirmationGate,
	DeferredConfirmationGate,
} from "../../src/tools/choice/ConfirmationGate.js";

describe("ChoiceTool", () => {
	it("question 为空返回错误", async () => {
		const tool = new ChoiceTool({ gate: new CancelledConfirmationGate() });
		const out = await tool.execute({
			question: "",
			options: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
		});
		expect(out).toMatch(/question is required/);
	});

	it("options 少于 2 个返回错误", async () => {
		const tool = new ChoiceTool({ gate: new CancelledConfirmationGate() });
		const out = await tool.execute({
			question: "Pick one",
			options: [{ id: "a", title: "A" }],
		});
		expect(out).toMatch(/at least 2/i);
	});

	it("options 多于 6 个返回错误", async () => {
		const tool = new ChoiceTool({ gate: new CancelledConfirmationGate() });
		const out = await tool.execute({
			question: "Pick one",
			options: Array.from({ length: 7 }, (_, i) => ({
				id: `o${i}`,
				title: `O${i}`,
			})),
		});
		expect(out).toMatch(/too many/i);
	});

	it("重复 id 去重", async () => {
		const gate = new DeferredConfirmationGate();
		gate.resolve({ type: "pick", optionId: "a" });
		const tool = new ChoiceTool({ gate });
		const out = await tool.execute({
			question: "Pick",
			options: [
				{ id: "a", title: "A" },
				{ id: "a", title: "A again" },
				{ id: "b", title: "B" },
			],
		});
		expect(out).toBe("user picked: a");
	});

	it("默认 gate 返回 cancelled", async () => {
		const tool = new ChoiceTool({ gate: new CancelledConfirmationGate() });
		const out = await tool.execute({
			question: "Pick",
			options: [
				{ id: "a", title: "A" },
				{ id: "b", title: "B" },
			],
		});
		expect(out).toBe("user cancelled the choice");
	});

	it("pick verdict → user picked: X", async () => {
		const gate = new DeferredConfirmationGate();
		const tool = new ChoiceTool({ gate });
		const p = tool.execute({
			question: "Pick",
			options: [
				{ id: "a", title: "A" },
				{ id: "b", title: "B" },
			],
		});
		gate.resolve({ type: "pick", optionId: "b" });
		expect(await p).toBe("user picked: b");
	});

	it("text verdict → user answered: ...", async () => {
		const gate = new DeferredConfirmationGate();
		const tool = new ChoiceTool({ gate });
		const p = tool.execute({
			question: "Pick",
			options: [
				{ id: "a", title: "A" },
				{ id: "b", title: "B" },
			],
			allowCustom: true,
		});
		gate.resolve({ type: "text", text: "neither — explain more" });
		expect(await p).toBe("user answered: neither — explain more");
	});
});
```

- [ ] **Step 3: 运行测试预期失败**

Run: `npm test -- tests/unit/ChoiceTool.test.ts`
Expected: FAIL(模块缺失)。

- [ ] **Step 4: 写 ChoiceTool**

`src/tools/choice/ChoiceTool.ts`:

```ts
import type {
	ChoiceOption,
	ConfirmationGate,
} from "./ConfirmationGate.js";
import { CancelledConfirmationGate } from "./ConfirmationGate.js";

function sanitizeOptions(raw: unknown): ChoiceOption[] {
	if (!Array.isArray(raw)) return [];
	const out: ChoiceOption[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const id = typeof e.id === "string" ? e.id.trim() : "";
		const title = typeof e.title === "string" ? e.title.trim() : "";
		if (!id || !title) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		const summary = typeof e.summary === "string" ? e.summary.trim() || undefined : undefined;
		const opt: ChoiceOption = { id, title };
		if (summary) opt.summary = summary;
		out.push(opt);
	}
	return out;
}

/**
 * ChoiceTool — 让模型在 2–6 个备选间停下问用户。底层依赖 ConfirmationGate 阻塞返回。
 * 没接 TUI 时使用 CancelledConfirmationGate(立即 cancel),避免在测试/无界面环境死锁。
 */
export class ChoiceTool {
	name = "ask_choice";
	description =
		"Render a picker with 2–6 alternatives. Use when the user is supposed to pick — never enumerate choices as prose. Skip when one option is clearly best (just do it) or a free-form text answer fits. Max 6 options; set `allowCustom:true` when their real answer might not fit.";

	private readonly gate: ConfirmationGate;

	constructor(options: { gate?: ConfirmationGate } = {}) {
		this.gate = options.gate ?? new CancelledConfirmationGate();
	}

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					question: {
						type: "string",
						description: "One-sentence question. Don't repeat the options here.",
					},
					options: {
						type: "array",
						description: "2–6 alternatives. Each: stable id + short title; summary optional.",
						items: {
							type: "object",
							properties: {
								id: { type: "string", description: "Stable id (A, B, C or option-1)." },
								title: { type: "string", description: "One-line label." },
								summary: {
									type: "string",
									description: "Optional dimmed second line, ≤80 chars.",
								},
							},
							required: ["id", "title"],
						},
					},
					allowCustom: {
						type: "boolean",
						description: "Shows a 'type my own answer' escape hatch. Default false.",
					},
				},
				required: ["question", "options"],
			},
		};
	}

	async execute(args: Record<string, any>): Promise<string> {
		const question = typeof args?.question === "string" ? args.question.trim() : "";
		if (!question) {
			return "Error: ask_choice: question is required — write one sentence explaining the decision.";
		}
		const options = sanitizeOptions(args?.options);
		if (options.length < 2) {
			return "Error: ask_choice: need at least 2 well-formed options (each with a non-empty id and title).";
		}
		if (options.length > 6) {
			return "Error: ask_choice: too many options (max 6). Split into two sequential ask_choice calls or narrow down first.";
		}
		const allowCustom = args?.allowCustom === true;
		const verdict = await this.gate.ask({ question, options, allowCustom });
		if (verdict.type === "pick") return `user picked: ${verdict.optionId}`;
		if (verdict.type === "text") return `user answered: ${verdict.text}`;
		return "user cancelled the choice";
	}
}
```

- [ ] **Step 5: 写 index.ts**

`src/tools/choice/index.ts`:

```ts
export { ChoiceTool } from "./ChoiceTool.js";
export {
	CancelledConfirmationGate,
	DeferredConfirmationGate,
} from "./ConfirmationGate.js";
export type {
	ConfirmationGate,
	ChoiceOption,
	ChoicePayload,
	ChoiceVerdict,
} from "./ConfirmationGate.js";
```

- [ ] **Step 6: 运行测试**

Run: `npm test -- tests/unit/ChoiceTool.test.ts`
Expected: PASS (7/7)。

- [ ] **Step 7: 提交**

```bash
git add src/tools/choice tests/unit/ChoiceTool.test.ts
git commit -m "feat(tools): add ChoiceTool with ConfirmationGate (blocking branch picker)"
```

---

## Task 7: 在 tools/index.ts 统一导出 + 烟雾测试

**Files:**
- Modify: `src/tools/index.ts`
- Test: `tests/unit/tools.test.ts` (顶部追加一段 smoke 用例)

- [ ] **Step 1: 修改 index.ts**

把 `src/tools/index.ts` 替换为:

```ts
export { ToolRegistry } from "./ToolRegistry.js";
export type { Tool, ToolCallContext } from "./ToolRegistry.js";
export type { ToolDefinition } from "../types/common.js";
export { TodoWriteTool } from "./todo/index.js";
export type { TodoItem, TodoStatus } from "./todo/index.js";
export { WebFetchTool } from "./web/index.js";
export {
	truncateToolResult,
	DEFAULT_MAX_RESULT_BYTES,
} from "./truncateResult.js";

// Wave 1 新增
export {
	ToolRateLimiter,
	normalizeToolRateLimitConfig,
	parseRateLimitedToolResult,
	DEFAULT_TOOL_RATE_LIMIT,
} from "./limits/index.js";
export type {
	ToolRateLimitConfig,
	ToolRateLimitBucketConfig,
	ToolRateLimitOption,
	NormalizedToolRateLimitConfig,
	NormalizedToolRateLimitBucket,
	ToolRateLimitDecision,
	RateLimitedToolResult,
} from "./limits/index.js";

export { ReadTracker } from "./state/index.js";

export {
	ChoiceTool,
	CancelledConfirmationGate,
	DeferredConfirmationGate,
} from "./choice/index.js";
export type {
	ConfirmationGate,
	ChoiceOption,
	ChoicePayload,
	ChoiceVerdict,
} from "./choice/index.js";
```

- [ ] **Step 2: 加 smoke 测试**

在 `tests/unit/tools.test.ts` 末尾(最外层 describe 之后,或单独一段)追加:

```ts
import {
	ChoiceTool,
	DeferredConfirmationGate,
	ReadTracker,
	ToolRateLimiter,
} from "../../src/tools/index.js";

describe("Wave1 集成 smoke", () => {
	it("从 index barrel 拿到的导出可用", async () => {
		const reg = new ToolRegistry({
			rateLimiter: new ToolRateLimiter({ aggregate: { maxCalls: 1000, windowSeconds: 60 } }),
		});
		const gate = new DeferredConfirmationGate();
		gate.resolve({ type: "pick", optionId: "yes" });
		reg.register(new ChoiceTool({ gate }) as any);
		// ReadTracker 仅作为类型 + 构造可达
		new ReadTracker();
		const res = await reg.execute({
			function: {
				name: "ask_choice",
				arguments: JSON.stringify({
					question: "Proceed?",
					options: [
						{ id: "yes", title: "Yes" },
						{ id: "no", title: "No" },
					],
				}),
			},
		});
		expect(res.content).toBe("user picked: yes");
	});
});
```

> 注:`ChoiceTool` 未显式 `implements Tool`,但形状匹配(`name` / `description` / `getDefinition` / `execute`)。`as any` 是 smoke 测试里一次性转换;若要更干净可让 `ChoiceTool implements Tool`(同步给 `TodoWriteTool`、`ReadFileTool` 等保持一致与否,留给后续整理任务)。

- [ ] **Step 3: 跑全量测试**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 4: typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 error。

- [ ] **Step 5: 提交**

```bash
git add src/tools/index.ts tests/unit/tools.test.ts
git commit -m "chore(tools): export Wave 1 modules from tools barrel + smoke test"
```

---

## 验证清单(Wave 1 完成判据)

执行者在所有 Task 完成后,逐项打勾:

- [ ] `npm test` 全绿
- [ ] `npm run typecheck` 0 error
- [ ] `npm run lint` 0 error
- [ ] `git log --oneline` 显示 6–7 个独立提交,每个对应一个 Task
- [ ] 旧有未被本计划改动的测试(`tools.test.ts` 的 ToolRegistry / ReadFileTool / ExecShellTool 老用例)全部保留并通过 — 即"接收方旧行为零回归"
- [ ] `src/tools/index.ts` barrel 导出新增 5 类符号:`ToolRateLimiter` 家族、`ReadTracker`、`ChoiceTool` + 两个 gate、`ConfirmationGate` 等类型
- [ ] `TodoItem` 接口加入 `activeForm` 必填字段后,所有下游 `TodoItem` 字面量构造点都已补齐

---

## 留给 Wave 2 的接口

本计划刻意**不做**以下事(避免范围蔓延):

- TUI 接线 `ConfirmationGate`(真实箭头键选择器)— 当前默认 `cancel`
- 把 `ToolRateLimiter` 接入应用主循环 / 配置文件(目前需手动构造注入到 `ToolRegistry`)
- `ReadTracker` 跨工具的全局共享(例如 `WriteFileTool` 写完后是否清除标记)
- `parseRateLimitedToolResult` 的上层使用(用于把 `isError` 的结构化 JSON 串转回对象,做退避)

这些都建立在 Wave 1 的基元之上,Wave 2 再处理。
