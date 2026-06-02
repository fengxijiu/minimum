# Wave 2b — Shell-Chain + Jobs:命令子系统

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DeepSeek-Reasonix 的命令执行子系统(shell 解析器 + 链式执行 + 后台任务管理)整体移植到接收方,顺便修复现有 `ExecShellTool` 的 `sh -c` 在 Windows 上不可用的硬伤。完成后接收方拥有:`run_command`(强化版,原生解析 `|` / `&&` / `>` / `2>&1`,跨平台)+ `run_background` + `job_output` + `wait_for_job` + `stop_job` + `list_jobs` 共 6 个工具。

**Architecture:**
- 移植采用**底层模块原样复制,工具层重写为接收方 Tool 类**的策略。捐赠方 `src/tools/shell/parse.ts`、`shell-chain.ts`、`shell/exec.ts`、`jobs.ts` 几乎可以 1:1 搬过来,只动 import 和外部依赖适配;而捐赠方 `shell.ts`(注册层)的逻辑要重写成 6 个 `Tool` 子类。
- 安全:沿用捐赠方的 allowlist + RISKY_ARGS + 敏感路径屏蔽。是否要确认提示,委托给**接收方已有的 `ApprovalManager`**(`src/approval/`),不引入捐赠方的 `pauseGate` / `NeedsConfirmationError` 模式——避免与现有审批系统冲突。
- 跨平台:Windows 用 `taskkill /T /F` 终止进程树,POSIX 用 `process.kill(-pid, ...)` 信号进程组。`spawn shell:false` + `tokenizeCommand` 把 argv 显式准备好,不依赖 shell 解释器。

**Tech Stack:** TypeScript ESM Node 22, vitest;**无新增 npm 依赖**(全部用 `node:child_process` / `node:os` / `node:fs` 内置)。

---

## 背景:接收方现状

- `src/tools/shell/ExecShellTool.ts`(110 行)直接 `spawn("sh", ["-c", args.command])`——在 Windows 上 `sh` 通常不在 PATH,**这工具实际上是坏的**。修复路径就是替换为捐赠方的 `runCommand`。
- `src/approval/ApprovalManager.ts` 已存在 5 档审批模式(`read-only` / `auto-edit` / `full-auto` / `suggest` / `never`),通过 `ApprovalPrompter` 函数接 TUI。新加的 shell 工具直接进入 ApprovalManager 流程,无需自己做闸门。

---

## 文件结构

### 新建(8 个文件,~1500 行,大部分是捐赠方原样复制)

| 路径 | 来源 | 责任 |
|---|---|---|
| `src/tools/shell/parse.ts` | 捐赠方 `tools/shell/parse.ts` 380 行 | 命令分词、操作符检测、allowlist + 敏感路径屏蔽 |
| `src/tools/shell/shell-chain.ts` | 捐赠方 `tools/shell-chain.ts` 577 行 | 解析 `|` / `&&` / `||` / `;` / `>` / `2>&1`,`runChain` 执行 |
| `src/tools/shell/exec.ts` | 捐赠方 `tools/shell/exec.ts` 407 行 | `runCommand` + `prepareSpawn` + `killProcessTree` + 跨平台编码 |
| `src/tools/shell/JobRegistry.ts` | 捐赠方 `tools/jobs.ts` 537 行(class JobRegistry 部分) | 后台进程注册表、ring-buffer、ready-signal |
| `src/tools/shell/RunBackgroundTool.ts` | 新建 | `run_background` Tool 子类 |
| `src/tools/shell/JobOutputTool.ts` | 新建 | `job_output` Tool 子类 |
| `src/tools/shell/WaitForJobTool.ts` | 新建 | `wait_for_job` Tool 子类 |
| `src/tools/shell/StopJobTool.ts` | 新建 | `stop_job` Tool 子类 |
| `src/tools/shell/ListJobsTool.ts` | 新建 | `list_jobs` Tool 子类 |

### 修改

| 路径 | 改动 |
|---|---|
| `src/tools/shell/ExecShellTool.ts` | 重写:用 `runCommand()` 取代 `spawn("sh", ["-c", ...])`,enforce allowlist,接 ApprovalManager |
| `src/tools/shell/index.ts` | 导出所有新工具 + JobRegistry |
| `src/tools/index.ts` | re-export 上述 |
| `src/config/createMiMoStack.ts` | 工厂构造 `JobRegistry` 单例,把 5 个 job 工具注册到 builtins |
| `src/config/MiMoConfig.ts` | 加 `shell?: ShellToolsConfig`(timeoutSec、maxOutputChars、extraAllowed) |
| `package.json` | 无改动(零新增依赖) |

### 测试

| 路径 | 用例数 |
|---|---|
| `tests/unit/shell-parse.test.ts` | ~12 |
| `tests/unit/shell-chain.test.ts` | ~10 |
| `tests/unit/shell-exec.test.ts` | ~6 |
| `tests/unit/JobRegistry.test.ts` | ~8 |
| `tests/unit/ExecShellTool.test.ts`(改写) | ~6 |
| `tests/unit/job-tools.test.ts` | ~5 |
| `tests/integration/wave2b-shell.test.ts` | ~3 |

---

## 移植注意事项(贯穿所有 Task)

1. **去掉 `@reasonix/core-utils` 依赖**:捐赠方 `parse.ts` 末尾 `export { derivePrefix } from "@reasonix/core-utils";`——接收方不安装该包。**做法**:在 `parse.ts` 末尾自己实现 `derivePrefix`(它的作用是从命令字符串提取 "always-allow" 前缀,比如 `git diff foo bar` → `git diff`)。
   ```ts
   export function derivePrefix(cmd: string): string {
   	const argv = tokenizeCommand(cmd);
   	if (argv.length === 0) return "";
   	// 沿用捐赠方约定:前两个 token 作为前缀(覆盖 "git diff" / "npm test" 这类双词命令)
   	return argv.slice(0, Math.min(2, argv.length)).join(" ");
   }
   ```

2. **去掉 `pauseGate` / `confirmationGate` 依赖**:捐赠方 `shell.ts:124,182` 用 `ctx?.confirmationGate ?? pauseGate` 等待用户审批。接收方**不引入 pauseGate**——把审批走 `ApprovalManager` 链路。具体做法见 Task 5。

3. **`addProjectShellAllowed` 调用**:捐赠方在 `always_allow` 决策后写入项目配置(`shell.ts:135`)。接收方先不做持久化——后续可以接 `MiMoConfig.shell.extraAllowed` 但本计划不实现"always allow"分支。

4. **导入路径**:捐赠方 `shell-chain.ts` import `from "./shell.js"`(同目录),接收方对应 `from "./exec.js"`(因为我们没有 `shell.ts` 注册层;把 `prepareSpawn`/`killProcessTree`/`smartDecodeOutput` 等放进 `exec.ts`)。

5. **测试用临时目录**:job 测试要 spawn 真实子进程;在 CI / Windows 上跑要避开依赖外部命令——用 `node -e "..."` 这种自包含命令。

---

## Task 1: 移植 `shell/parse.ts`(命令分词 + allowlist + 敏感路径)

**Files:**
- Create: `src/tools/shell/parse.ts`
- Test: `tests/unit/shell-parse.test.ts`

### Step 1: 写失败测试

新建 `tests/unit/shell-parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	tokenizeCommand,
	detectShellOperator,
	isAllowed,
	isCommandAllowed,
	hasSensitivePathArgs,
	derivePrefix,
	BUILTIN_ALLOWLIST,
} from "../../src/tools/shell/parse.js";

describe("tokenizeCommand", () => {
	it("简单空格分词", () => {
		expect(tokenizeCommand("ls -la")).toEqual(["ls", "-la"]);
	});
	it("双引号保护空格", () => {
		expect(tokenizeCommand('echo "hello world"')).toEqual(["echo", "hello world"]);
	});
	it("Windows 路径里的反斜杠保留", () => {
		expect(tokenizeCommand('cat "C:\\Users\\foo\\.bar"')).toEqual([
			"cat",
			"C:\\Users\\foo\\.bar",
		]);
	});
	it("未闭合引号抛错", () => {
		expect(() => tokenizeCommand('echo "unclosed')).toThrow(/unclosed/);
	});
});

describe("detectShellOperator", () => {
	it("识别裸 pipe", () => {
		expect(detectShellOperator("ls | grep x")).toBe("|");
	});
	it("识别 &&", () => {
		expect(detectShellOperator("a && b")).toBe("&&");
	});
	it("引号内的 | 不算操作符", () => {
		expect(detectShellOperator('grep "a|b" file')).toBeNull();
	});
	it("纯命令返回 null", () => {
		expect(detectShellOperator("ls -la")).toBeNull();
	});
});

describe("isAllowed (单段命令)", () => {
	it("git status 在 BUILTIN_ALLOWLIST 里", () => {
		expect(isAllowed("git status")).toBe(true);
	});
	it("rm -rf 不在 allowlist", () => {
		expect(isAllowed("rm -rf /")).toBe(false);
	});
	it("RISKY_ARGS:git branch -D 被降级", () => {
		expect(isAllowed("git branch foo")).toBe(true);
		expect(isAllowed("git branch -D foo")).toBe(false);
	});
});

describe("derivePrefix", () => {
	it('"git diff foo" → "git diff"', () => {
		expect(derivePrefix("git diff foo")).toBe("git diff");
	});
	it('"ls -la" → "ls -la"', () => {
		expect(derivePrefix("ls -la")).toBe("ls -la");
	});
	it("空串返回空", () => {
		expect(derivePrefix("")).toBe("");
	});
});
```

### Step 2: 跑测试预期 FAIL(模块不存在)

Run: `npm test -- tests/unit/shell-parse.test.ts`

### Step 3: 移植源文件

把 `tmp/DeepSeek-Reasonix-main/src/tools/shell/parse.ts` 整文件复制到 `src/tools/shell/parse.ts`,改动:

1. 第 1 行 import 保留(homedir、pathMod)。
2. 第 3-8 行 import `from "../shell-chain.js"`——保留,Task 2 会创建该文件。该 Task 完成前 typecheck 会暂时失败,但本 Task 的单元测试只针对**不依赖 shell-chain 的函数**(`tokenizeCommand` / `detectShellOperator` / `isAllowed` / `derivePrefix` 等),所以 vitest 可以执行通过——它在运行时才会触发 `shell-chain` 的解析。
3. **删除**最后一行 `export { derivePrefix } from "@reasonix/core-utils";`,改为自定义实现(见"移植注意事项 1")。

> ⚠️ 注意 `isCommandAllowed`(行 350)调用 `parseCommandChain`/`chainAllowed`/`redirectsEscapeSandbox` 都依赖 `shell-chain`。Task 1 阶段如果 typecheck 报这几个未定义,**忽略**——Task 2 落地后会自然恢复。如果你想分阶段验证,可以**临时**把 `isCommandAllowed` body 改为 `return isAllowed(cmd, extra, projectRoot, sensitivePathConfig);`,Task 2 完成时恢复。本计划默认采用"临时简化"方案。

### Step 4: 跑单元测试

Run: `npm test -- tests/unit/shell-parse.test.ts`
Expected: 全部 PASS。

### Step 5: Commit

```bash
git add src/tools/shell/parse.ts tests/unit/shell-parse.test.ts
git commit -m "feat(shell): port tokenizer + allowlist + sensitive-path guards from DeepSeek-Reasonix"
```

---

## Task 2: 移植 `shell-chain.ts`(链解析 + runChain)

**Files:**
- Create: `src/tools/shell/shell-chain.ts`
- Test: `tests/unit/shell-chain.test.ts`

### Step 1: 写失败测试

`tests/unit/shell-chain.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCommandChain, chainAllowed, isNullDeviceAlias } from "../../src/tools/shell/shell-chain.js";

describe("parseCommandChain", () => {
	it("单段命令返回 null(不是 chain)", () => {
		expect(parseCommandChain("ls -la")).toBeNull();
	});
	it("pipe 链 segments 数量正确", () => {
		const c = parseCommandChain("a | b | c");
		expect(c).not.toBeNull();
		expect(c!.segments).toHaveLength(3);
		expect(c!.ops).toEqual(["|", "|"]);
	});
	it("&& 与 || 组合", () => {
		const c = parseCommandChain("a && b || c");
		expect(c!.ops).toEqual(["&&", "||"]);
	});
	it("> 重定向落到 segment.redirects", () => {
		const c = parseCommandChain("echo hi > out.txt");
		expect(c).not.toBeNull();
		expect(c!.segments[0]!.redirects).toEqual([
			{ kind: ">", target: "out.txt" },
		]);
	});
	it("2>&1 不要 target", () => {
		const c = parseCommandChain("foo 2>&1");
		expect(c!.segments[0]!.redirects[0]).toEqual({ kind: "2>&1", target: "" });
	});
});

describe("isNullDeviceAlias", () => {
	it("/dev/null 是 null device", () => {
		expect(isNullDeviceAlias("/dev/null")).toBe(true);
	});
	it("NUL(Windows)是 null device", () => {
		expect(isNullDeviceAlias("NUL")).toBe(true);
	});
	it("普通文件不是", () => {
		expect(isNullDeviceAlias("out.txt")).toBe(false);
	});
});

describe("chainAllowed", () => {
	it("全部 segment 通过 → allowed", () => {
		const c = parseCommandChain("ls | grep x");
		expect(chainAllowed(c!, () => true)).toBe(true);
	});
	it("任一 segment 失败 → not allowed", () => {
		const c = parseCommandChain("ls | rm");
		let i = 0;
		expect(chainAllowed(c!, () => i++ === 0)).toBe(false);
	});
});
```

### Step 2: 跑测试预期 FAIL

Run: `npm test -- tests/unit/shell-chain.test.ts`

### Step 3: 移植源文件

把 `tmp/DeepSeek-Reasonix-main/src/tools/shell-chain.ts` 复制到 `src/tools/shell/shell-chain.ts`(注意路径加上 `shell/` 子目录)。改动:

1. 第 7 行 `import ... from "./shell.js"`——改为 `from "./exec.js"`。捐赠方在 `tools/shell.ts` re-export 了 `prepareSpawn`/`killProcessTree`/`smartDecodeOutput`/`isDqEscape`,接收方把这些直接放在 `exec.ts`(Task 3 实现)+ `parse.ts` 已有 `isDqEscape`。所以这个 import 改为:
   ```ts
   import { killProcessTree, prepareSpawn, smartDecodeOutput } from "./exec.js";
   import { isDqEscape } from "./parse.js";
   ```

> 同 Task 1 的说明,Task 2 完成时 `exec.ts` 可能还没有 prepareSpawn 等导出——若先做 Task 2 再 Task 3,这里会暂时 typecheck 红,Task 3 完成后变绿。**推荐顺序:Task 1 → Task 3 → Task 2**,理由是 Task 3 的 `exec.ts` 不依赖 chain,可以先落地;Task 2 的 `shell-chain.ts` 依赖 exec.ts 的 helper。

### Step 4: 跑单元测试

Run: `npm test -- tests/unit/shell-chain.test.ts`
Expected: 全部 PASS(`parseCommandChain` 等纯解析函数不依赖运行时 spawn)。

### Step 5: Commit

```bash
git add src/tools/shell/shell-chain.ts tests/unit/shell-chain.test.ts
git commit -m "feat(shell): port command-chain parser and chain executor"
```

---

## Task 3: 移植 `shell/exec.ts`(runCommand + 跨平台 helper)

**Files:**
- Create: `src/tools/shell/exec.ts`
- Test: `tests/unit/shell-exec.test.ts`

### Step 1: 写失败测试

`tests/unit/shell-exec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runCommand, DEFAULT_TIMEOUT_SEC, DEFAULT_MAX_OUTPUT_CHARS } from "../../src/tools/shell/exec.js";

describe("runCommand", () => {
	it("成功执行 node -e 输出 hello", async () => {
		const r = await runCommand('node -e "console.log(\\"hello\\")"', { cwd: process.cwd() });
		expect(r.exitCode).toBe(0);
		expect(r.output).toContain("hello");
		expect(r.timedOut).toBe(false);
	});

	it("非零退出码被捕获", async () => {
		const r = await runCommand('node -e "process.exit(2)"', { cwd: process.cwd() });
		expect(r.exitCode).toBe(2);
	});

	it("超时杀进程", async () => {
		const r = await runCommand('node -e "setTimeout(()=>{}, 10000)"', {
			cwd: process.cwd(),
			timeoutSec: 1,
		});
		expect(r.timedOut).toBe(true);
	}, 5000);

	it("AbortSignal 触发杀进程", async () => {
		const ctrl = new AbortController();
		const p = runCommand('node -e "setTimeout(()=>{}, 10000)"', {
			cwd: process.cwd(),
			signal: ctrl.signal,
		});
		setTimeout(() => ctrl.abort(), 50);
		const r = await p;
		expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
	}, 5000);

	it("输出被截到 maxOutputChars", async () => {
		const r = await runCommand(
			'node -e "console.log(\\"x\\".repeat(1000))"',
			{ cwd: process.cwd(), maxOutputChars: 100 },
		);
		expect(r.output.length).toBeLessThanOrEqual(200); // 100 + truncation marker
	});

	it("默认常量正确", () => {
		expect(DEFAULT_TIMEOUT_SEC).toBe(60);
		expect(DEFAULT_MAX_OUTPUT_CHARS).toBe(32000);
	});
});
```

### Step 2: 跑测试预期 FAIL

### Step 3: 移植源文件

把 `tmp/DeepSeek-Reasonix-main/src/tools/shell/exec.ts` 复制到 `src/tools/shell/exec.ts`。改动:

1. 第 4 行 `import { parseCommandChain, runChain } from "../shell-chain.js";`——改为 `from "./shell-chain.js"`(同目录)。
2. 第 5 行 `import { tokenizeCommand } from "./parse.js";` 保留。
3. **保留 web-tree-sitter 之类的依赖**——exec.ts 本身没有这些。
4. 检查整文件是否有 `@reasonix/core-utils` 引用——如有,自实现。

### Step 4: 跑测试

Run: `npm test -- tests/unit/shell-exec.test.ts`
Expected: 全部 PASS。

### Step 5: Commit

```bash
git add src/tools/shell/exec.ts tests/unit/shell-exec.test.ts
git commit -m "feat(shell): port runCommand + cross-platform process control"
```

---

## Task 4: 移植 `jobs.ts`(JobRegistry)

**Files:**
- Create: `src/tools/shell/JobRegistry.ts`
- Test: `tests/unit/JobRegistry.test.ts`

### Step 1: 写失败测试

`tests/unit/JobRegistry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { JobRegistry } from "../../src/tools/shell/JobRegistry.js";

describe("JobRegistry", () => {
	it("启动短命进程并捕获 exit code", async () => {
		const jobs = new JobRegistry();
		const r = await jobs.start('node -e "console.log(\\"ok\\")"', {
			cwd: process.cwd(),
			waitSec: 2,
		});
		expect(r.jobId).toBeGreaterThan(0);
		expect(r.preview).toContain("ok");
		// 等待真正退出
		await jobs.waitForJob(r.jobId, { timeoutMs: 3000 });
		const rec = jobs.list().find(j => j.id === r.jobId);
		expect(rec?.running).toBe(false);
		expect(rec?.exitCode).toBe(0);
	}, 8000);

	it("拒绝带 shell 操作符的命令", async () => {
		const jobs = new JobRegistry();
		await expect(jobs.start("a | b", { cwd: process.cwd() })).rejects.toThrow(/shell operator/);
	});

	it("拒绝空命令", async () => {
		const jobs = new JobRegistry();
		await expect(jobs.start("", { cwd: process.cwd() })).rejects.toThrow(/empty command/);
	});

	it("list 返回 snapshot", async () => {
		const jobs = new JobRegistry();
		await jobs.start('node -e "console.log(1)"', { cwd: process.cwd(), waitSec: 2 });
		expect(jobs.list().length).toBeGreaterThanOrEqual(1);
	}, 5000);

	it("stop 后 record.running === false", async () => {
		const jobs = new JobRegistry();
		const r = await jobs.start('node -e "setTimeout(()=>{}, 30000)"', {
			cwd: process.cwd(),
			waitSec: 1,
		});
		const stopped = await jobs.stop(r.jobId, { graceMs: 100 });
		expect(stopped?.running).toBe(false);
	}, 10000);

	it("ready signal 短路 wait", async () => {
		const jobs = new JobRegistry();
		const r = await jobs.start(
			'node -e "console.log(\\"compiled successfully\\"); setInterval(()=>{}, 1000)"',
			{ cwd: process.cwd(), waitSec: 10 },
		);
		expect(r.readyMatched).toBe(true);
		expect(r.stillRunning).toBe(true);
		await jobs.stop(r.jobId);
	}, 5000);

	it("runningCount 准确", async () => {
		const jobs = new JobRegistry();
		expect(jobs.runningCount()).toBe(0);
		const r = await jobs.start(
			'node -e "setInterval(()=>{}, 1000)"',
			{ cwd: process.cwd(), waitSec: 1 },
		);
		expect(jobs.runningCount()).toBe(1);
		await jobs.stop(r.jobId);
		expect(jobs.runningCount()).toBe(0);
	}, 5000);
});
```

### Step 2: 跑测试预期 FAIL

### Step 3: 移植源文件

把 `tmp/DeepSeek-Reasonix-main/src/tools/jobs.ts` 复制到 `src/tools/shell/JobRegistry.ts`。改动:

1. 第 5 行 `import { detectShellOperator, prepareSpawn, tokenizeCommand } from "./shell.js";`——改为:
   ```ts
   import { prepareSpawn } from "./exec.js";
   import { detectShellOperator, tokenizeCommand } from "./parse.js";
   ```
2. 文件顶部加 `export` 把所有 export 项保留。

### Step 4: 跑测试

Run: `npm test -- tests/unit/JobRegistry.test.ts`
Expected: 全部 PASS。Windows / Linux 平台可能有 ready-signal 那个测试时间偏差,适当放宽超时即可。

### Step 5: Commit

```bash
git add src/tools/shell/JobRegistry.ts tests/unit/JobRegistry.test.ts
git commit -m "feat(shell): port JobRegistry — background process lifecycle + ring buffer"
```

---

## Task 5: 重写 `ExecShellTool`(用 runCommand,接 ApprovalManager)

**Files:**
- Modify: `src/tools/shell/ExecShellTool.ts`
- Test: `tests/unit/ExecShellTool.test.ts`(改写)

### Step 1: 改写测试

把 `tests/unit/ExecShellTool.test.ts`(若不存在则新建)替换为:

```ts
import { describe, expect, it } from "vitest";
import { ExecShellTool } from "../../src/tools/shell/ExecShellTool.js";

describe("ExecShellTool (rewritten with runCommand)", () => {
	it("跨平台执行 node -e 输出", async () => {
		const tool = new ExecShellTool();
		const out = await tool.execute({ command: 'node -e "console.log(\\"hi\\")"' });
		expect(out).toContain("hi");
	}, 10000);

	it("非零退出码体现在结果里", async () => {
		const tool = new ExecShellTool();
		const out = await tool.execute({ command: 'node -e "process.exit(3)"' });
		expect(out).toMatch(/exit 3|退出码 3/);
	}, 10000);

	it("超时被报告", async () => {
		const tool = new ExecShellTool();
		const out = await tool.execute({
			command: 'node -e "setTimeout(()=>{}, 10000)"',
			timeoutSec: 1,
		});
		expect(out).toMatch(/timeout|超时|killed after timeout/i);
	}, 5000);

	it("AbortSignal 触发取消", async () => {
		const tool = new ExecShellTool();
		const ctrl = new AbortController();
		const p = tool.execute(
			{ command: 'node -e "setTimeout(()=>{}, 10000)"' },
			{ signal: ctrl.signal },
		);
		setTimeout(() => ctrl.abort(), 50);
		const out = await p;
		// 取消后输出应包含取消标记或非零状态
		expect(out).toBeTruthy();
	}, 5000);

	it("getDefinition 暴露 command/timeoutSec/cwd 参数", () => {
		const tool = new ExecShellTool();
		const def = tool.getDefinition();
		expect(def.parameters.properties.command).toBeDefined();
		expect(def.parameters.properties.timeoutSec).toBeDefined();
		expect(def.parameters.required).toContain("command");
	});

	it("空命令返回错误", async () => {
		const tool = new ExecShellTool();
		const out = await tool.execute({ command: "" });
		expect(out).toMatch(/empty|空/i);
	});
});
```

> 注意:旧版 `ExecShellTool` 参数名是 `timeout`(ms),新版改名为 `timeoutSec`(秒),与捐赠方一致。这是**破坏性改动**——本 Task 之前的 `tools.test.ts` 用例(`'{"command":"echo hello"}'`)不影响,但若有任何地方传 `timeout:5000` 需要改成 `timeoutSec:5`。

### Step 2: 跑测试预期 FAIL(旧实现用 sh -c,Windows 失败)

Run: `npm test -- tests/unit/ExecShellTool.test.ts`

### Step 3: 改写 `ExecShellTool.ts`

替换整文件为:

```ts
import { runCommand } from "./exec.js";
import { isCommandAllowed, derivePrefix } from "./parse.js";
import { truncateToolResult } from "../truncateResult.js";
import type { ApprovalManager } from "../../approval/ApprovalManager.js";

export interface ExecShellToolOptions {
	rootDir?: string;
	timeoutSec?: number;
	maxOutputChars?: number;
	extraAllowed?: readonly string[] | (() => readonly string[]);
	approvalManager?: ApprovalManager;
}

export class ExecShellTool {
	name = "exec_shell";
	description =
		"Run a shell command. Native arg-parsing — supports `|` `&&` `||` `;` `>` `>>` `2>&1` `&>` without invoking a real shell (cross-platform). Allowlisted read-only / test / lint commands run immediately; others gate on the configured approval mode.";

	private readonly rootDir?: string;
	private readonly defaultTimeoutSec: number;
	private readonly maxOutputChars: number;
	private readonly getExtraAllowed: () => readonly string[];
	private readonly approvalManager?: ApprovalManager;

	constructor(options: ExecShellToolOptions = {}) {
		this.rootDir = options.rootDir;
		this.defaultTimeoutSec = options.timeoutSec ?? 60;
		this.maxOutputChars = options.maxOutputChars ?? 32_000;
		this.approvalManager = options.approvalManager;
		this.getExtraAllowed =
			typeof options.extraAllowed === "function"
				? options.extraAllowed
				: (() => {
						const snap = options.extraAllowed ?? [];
						return () => snap;
					})();
	}

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "Full command line." },
					timeoutSec: {
						type: "integer",
						description: `Per-command timeout in seconds (default ${this.defaultTimeoutSec}).`,
					},
					cwd: { type: "string", description: "Working directory override." },
				},
				required: ["command"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { workingDirectory?: string; signal?: AbortSignal },
	): Promise<string> {
		const cmd = typeof args.command === "string" ? args.command.trim() : "";
		if (!cmd) return "Error: empty command";

		const cwd =
			(typeof args.cwd === "string" && args.cwd) ||
			context?.workingDirectory ||
			this.rootDir ||
			process.cwd();
		const timeoutSec = Math.max(1, Math.min(600, args.timeoutSec ?? this.defaultTimeoutSec));

		// Allowlist + approval gate
		const allowed = isCommandAllowed(cmd, this.getExtraAllowed(), cwd);
		if (!allowed && this.approvalManager) {
			const decision = await this.approvalManager.checkApproval({
				toolName: this.name,
				args: { command: cmd },
				risk: "high",
				description: `Run shell command: ${cmd}`,
				prefix: derivePrefix(cmd),
			});
			if (!decision.approved) {
				return `Error: command "${cmd}" denied by approval gate${decision.reason ? ` — ${decision.reason}` : ""}`;
			}
		}

		const result = await runCommand(cmd, {
			cwd,
			timeoutSec,
			maxOutputChars: this.maxOutputChars,
			signal: context?.signal,
		});

		const header = result.timedOut
			? `$ ${cmd}\n[killed after timeout]`
			: `$ ${cmd}\n[exit ${result.exitCode ?? "?"}]`;
		const body = result.output ? `${header}\n${result.output}` : header;
		return truncateToolResult(body, undefined, "exec_shell");
	}
}
```

> 注:`ApprovalManager.checkApproval` 的确切签名需要 verify——读 `src/approval/ApprovalManager.ts` 第 79-134 行,把参数对齐。若发现接收方 `ApprovalManager.checkApproval` 的入参形状不同,这里跟着改。

### Step 4: 跑测试

Run: `npm test -- tests/unit/ExecShellTool.test.ts`
Expected: 6/6 PASS。

### Step 5: 检查旧 tools.test.ts

Run: `npm test -- tests/unit/tools.test.ts`
Expected: 测试里有 `'{"command":"echo hello"}'`——它使用 `sh -c` 时能工作但新版需要 `echo` 在 PATH。`echo` 在 Windows cmd 内置,但在 spawn shell:false 时不是 standalone exe——可能会 fail with ENOENT。**修复**:把测试改用 `node -e "console.log(\\"hello\\")"`。

```ts
// 旧:
const result = await registry.execute({
	function: { name: "exec_shell", arguments: '{"command": "echo hello"}' },
});
// 改为:
const result = await registry.execute({
	function: { name: "exec_shell", arguments: '{"command":"node -e \\"console.log(\'hello\')\\""}' },
});
```

### Step 6: Commit

```bash
git add src/tools/shell/ExecShellTool.ts tests/unit/ExecShellTool.test.ts tests/unit/tools.test.ts
git commit -m "feat(shell): rewrite ExecShellTool to use runCommand + ApprovalManager

Drops broken 'sh -c' spawn (POSIX-only) in favor of native argv tokenization.
Now supports pipes/redirects/chains cross-platform. Allowlist-gated;
non-allowlisted commands gate on ApprovalManager."
```

---

## Task 6: 5 个新 Job 工具

**Files:**
- Create: `src/tools/shell/RunBackgroundTool.ts`
- Create: `src/tools/shell/JobOutputTool.ts`
- Create: `src/tools/shell/WaitForJobTool.ts`
- Create: `src/tools/shell/StopJobTool.ts`
- Create: `src/tools/shell/ListJobsTool.ts`
- Create: `src/tools/shell/index.ts`(barrel)
- Test: `tests/unit/job-tools.test.ts`

### Step 1: 写共享测试

`tests/unit/job-tools.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { JobRegistry } from "../../src/tools/shell/JobRegistry.js";
import { RunBackgroundTool } from "../../src/tools/shell/RunBackgroundTool.js";
import { JobOutputTool } from "../../src/tools/shell/JobOutputTool.js";
import { WaitForJobTool } from "../../src/tools/shell/WaitForJobTool.js";
import { StopJobTool } from "../../src/tools/shell/StopJobTool.js";
import { ListJobsTool } from "../../src/tools/shell/ListJobsTool.js";

describe("Job tools (shared JobRegistry)", () => {
	it("run_background → job_output → stop_job 全流程", async () => {
		const jobs = new JobRegistry();
		const run = new RunBackgroundTool({ jobs, rootDir: process.cwd() });
		const out = new JobOutputTool({ jobs });
		const stop = new StopJobTool({ jobs });
		const list = new ListJobsTool({ jobs });

		const started = await run.execute({
			command: 'node -e "console.log(\\"started\\"); setInterval(()=>{}, 1000)"',
			waitSec: 2,
		});
		expect(started).toMatch(/started|job \d+/i);

		const allJobs = await list.execute({});
		expect(allJobs).toMatch(/\d/);

		// 从 list 取 job id 是脆的,改为直接拿 JobRegistry
		const id = jobs.list()[0]!.id;
		const tail = await out.execute({ jobId: id });
		expect(tail).toContain("started");

		const stopped = await stop.execute({ jobId: id });
		expect(stopped).toMatch(/stopped|exit/i);
	}, 10000);

	it("wait_for_job 等待 exit", async () => {
		const jobs = new JobRegistry();
		const run = new RunBackgroundTool({ jobs, rootDir: process.cwd() });
		const wait = new WaitForJobTool({ jobs });
		await run.execute({ command: 'node -e "console.log(\\"done\\")"', waitSec: 1 });
		const id = jobs.list()[0]!.id;
		const res = await wait.execute({ jobId: id, timeoutMs: 3000 });
		const parsed = JSON.parse(res);
		expect(parsed.exited).toBe(true);
		expect(parsed.exitCode).toBe(0);
	}, 8000);

	it("job_output: not found 时返回提示", async () => {
		const jobs = new JobRegistry();
		const out = new JobOutputTool({ jobs });
		const r = await out.execute({ jobId: 99999 });
		expect(r).toMatch(/not found|list_jobs/);
	});

	it("list_jobs 空 → '(no background jobs)'", async () => {
		const jobs = new JobRegistry();
		const list = new ListJobsTool({ jobs });
		const r = await list.execute({});
		expect(r).toMatch(/no background jobs/i);
	});

	it("getDefinition 暴露正确的 schema", () => {
		const jobs = new JobRegistry();
		expect(new RunBackgroundTool({ jobs, rootDir: "/" }).getDefinition().name).toBe("run_background");
		expect(new JobOutputTool({ jobs }).getDefinition().name).toBe("job_output");
		expect(new WaitForJobTool({ jobs }).getDefinition().name).toBe("wait_for_job");
		expect(new StopJobTool({ jobs }).getDefinition().name).toBe("stop_job");
		expect(new ListJobsTool({ jobs }).getDefinition().name).toBe("list_jobs");
	});
});
```

### Step 2: 跑测试预期 FAIL

### Step 3: 实现 5 个 Tool 子类

每个工具都是同一个套路:接收 `{ jobs: JobRegistry, ... }` 构造参数,`execute()` 调相应的 `jobs.X()` 方法,把结果格式化成字符串。

**`src/tools/shell/RunBackgroundTool.ts`**(参考捐赠方 `tools/shell.ts:149-205` 的 fn 体):

```ts
import { JobRegistry } from "./JobRegistry.js";
import { isCommandAllowed, derivePrefix } from "./parse.js";
import type { ApprovalManager } from "../../approval/ApprovalManager.js";
import * as path from "node:path";

export interface RunBackgroundToolOptions {
	jobs: JobRegistry;
	rootDir: string;
	extraAllowed?: readonly string[] | (() => readonly string[]);
	approvalManager?: ApprovalManager;
	onJobsChanged?: () => void;
}

export class RunBackgroundTool {
	name = "run_background";
	description =
		"Spawn a long-running process detached. Waits up to waitSec for startup or a ready signal. Returns job id. Use for dev servers / watchers / installs / large builds. No shell operators in this command.";

	private readonly jobs: JobRegistry;
	private readonly rootDir: string;
	private readonly getExtraAllowed: () => readonly string[];
	private readonly approvalManager?: ApprovalManager;
	private readonly onJobsChanged?: () => void;

	constructor(options: RunBackgroundToolOptions) {
		this.jobs = options.jobs;
		this.rootDir = path.resolve(options.rootDir);
		this.approvalManager = options.approvalManager;
		this.onJobsChanged = options.onJobsChanged;
		this.getExtraAllowed =
			typeof options.extraAllowed === "function"
				? options.extraAllowed
				: (() => {
						const snap = options.extraAllowed ?? [];
						return () => snap;
					})();
	}

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "Full command line — no shell operators." },
					cwd: {
						type: "string",
						description: "Workspace-relative or absolute (must resolve inside rootDir).",
					},
					waitSec: { type: "integer", description: "Max startup wait. 0..30, default 3." },
				},
				required: ["command"],
			},
		};
	}

	async execute(
		args: Record<string, any>,
		context?: { signal?: AbortSignal; workingDirectory?: string },
	): Promise<string> {
		const cmd = typeof args.command === "string" ? args.command.trim() : "";
		if (!cmd) return "Error: empty command";
		const cwd = this.resolveCwd(args.cwd);

		const allowed = isCommandAllowed(cmd, this.getExtraAllowed(), this.rootDir);
		if (!allowed && this.approvalManager) {
			const decision = await this.approvalManager.checkApproval({
				toolName: this.name,
				args: { command: cmd, cwd },
				risk: "high",
				description: `Spawn background: ${cmd}`,
				prefix: derivePrefix(cmd),
			});
			if (!decision.approved) {
				return `Error: command denied${decision.reason ? ` — ${decision.reason}` : ""}`;
			}
		}

		const result = await this.jobs.start(cmd, {
			cwd,
			waitSec: args.waitSec,
			signal: context?.signal,
		});
		this.onJobsChanged?.();
		return this.format(result);
	}

	private resolveCwd(raw: unknown): string {
		if (!raw || typeof raw !== "string" || !raw.trim()) return this.rootDir;
		const resolved = path.resolve(this.rootDir, raw);
		const rel = path.relative(this.rootDir, resolved);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new Error(`cwd "${raw}" resolves outside rootDir ${this.rootDir}`);
		}
		return resolved;
	}

	private format(r: import("./JobRegistry.js").JobStartResult): string {
		const header = r.stillRunning
			? `[job ${r.jobId} started · pid ${r.pid ?? "?"} · ${r.readyMatched ? "READY" : "running"}]`
			: r.exitCode !== null
				? `[job ${r.jobId} exited during startup · exit ${r.exitCode}]`
				: `[job ${r.jobId} failed to start]`;
		return r.preview ? `${header}\n${r.preview}` : header;
	}
}
```

**`JobOutputTool.ts`, `WaitForJobTool.ts`, `StopJobTool.ts`, `ListJobsTool.ts`** 模式相同——直接参考捐赠方 `tools/shell.ts:207-317` 各 `fn` 体,改写为 Tool 类。**关键差异**:
- 不需要 `approvalManager` 检查(只读 / 只对自己启动的 job 操作)
- 构造器只收 `{ jobs: JobRegistry, onJobsChanged?: () => void }`
- `WaitForJobTool.execute` 返回 `JSON.stringify({ jobId, exited, exitCode, latestOutput })`
- 其他三个返回格式化字符串(formatJobRead / formatJobStop / formatJobRow)

直接复用捐赠方的 format helper(`formatJobRead` / `formatJobStop` / `formatJobRow` / `tailLines`),复制到 `src/tools/shell/format.ts` 一并导入。

### Step 4: barrel index.ts

`src/tools/shell/index.ts`:

```ts
export { ExecShellTool } from "./ExecShellTool.js";
export { JobRegistry } from "./JobRegistry.js";
export { RunBackgroundTool } from "./RunBackgroundTool.js";
export { JobOutputTool } from "./JobOutputTool.js";
export { WaitForJobTool } from "./WaitForJobTool.js";
export { StopJobTool } from "./StopJobTool.js";
export { ListJobsTool } from "./ListJobsTool.js";
export type {
	JobStartResult,
	JobReadResult,
	JobWaitResult,
	JobRecord,
} from "./JobRegistry.js";
```

### Step 5: 跑测试

Run: `npm test -- tests/unit/job-tools.test.ts`
Expected: 5/5 PASS。

### Step 6: Commit

```bash
git add src/tools/shell tests/unit/job-tools.test.ts
git commit -m "feat(shell): add 5 background-job tools (run_background, job_output, wait_for_job, stop_job, list_jobs)"
```

---

## Task 7: 工厂注册 + 集成测试

**Files:**
- Modify: `src/config/createMiMoStack.ts`
- Modify: `src/config/MiMoConfig.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/integration/wave2b-shell.test.ts`

### Step 1: 加 `MiMoConfig.shell`

在 `MiMoConfig.ts` 接口里加:

```ts
	shell?: {
		timeoutSec?: number;
		maxOutputChars?: number;
		extraAllowed?: readonly string[];
	};
```

`DEFAULT_MIMO_CONFIG.shell`:

```ts
	shell: {
		timeoutSec: 60,
		maxOutputChars: 32_000,
		extraAllowed: [],
	},
```

`mergeConfig` 加:

```ts
		shell: { ...DEFAULT_MIMO_CONFIG.shell, ...user.shell },
```

### Step 2: 改 `createMiMoStack`

工厂里加共享 `JobRegistry`,把 5 个工具加进 builtins:

```ts
import { ExecShellTool } from "../tools/shell/ExecShellTool.js";
import { JobRegistry } from "../tools/shell/JobRegistry.js";
import { RunBackgroundTool } from "../tools/shell/RunBackgroundTool.js";
import { JobOutputTool } from "../tools/shell/JobOutputTool.js";
import { WaitForJobTool } from "../tools/shell/WaitForJobTool.js";
import { StopJobTool } from "../tools/shell/StopJobTool.js";
import { ListJobsTool } from "../tools/shell/ListJobsTool.js";

// ... 工厂函数体内,在 builtins 之前:
const jobs = new JobRegistry();
const shellOpts = {
	rootDir: workingDirectory,
	timeoutSec: cfg.shell.timeoutSec,
	maxOutputChars: cfg.shell.maxOutputChars,
	extraAllowed: cfg.shell.extraAllowed,
	approvalManager,
};

const builtins = [
	new TodoWriteTool(),
	new ApplyPatchTool(),
	new ChoiceTool({ gate: deps.confirmationGate }),
	new ExecShellTool(shellOpts),
	new RunBackgroundTool({ jobs, ...shellOpts }),
	new JobOutputTool({ jobs }),
	new WaitForJobTool({ jobs }),
	new StopJobTool({ jobs }),
	new ListJobsTool({ jobs }),
] as const;
```

`MiMoStack` 暴露 `jobs`:

```ts
export interface MiMoStack {
	// ...
	jobs: JobRegistry;
}
```

return 加 `jobs`。

### Step 3: 集成测试

`tests/integration/wave2b-shell.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMiMoStack } from "../../src/config/createMiMoStack.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";

describe("Wave 2b 端到端 — shell + jobs 注册到工厂", () => {
	it("createMiMoStack 注册全部 6 个 shell 工具", () => {
		const reg = new ToolRegistry();
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, reg, process.cwd(), {});
		expect(reg.has("exec_shell")).toBe(true);
		expect(reg.has("run_background")).toBe(true);
		expect(reg.has("job_output")).toBe(true);
		expect(reg.has("wait_for_job")).toBe(true);
		expect(reg.has("stop_job")).toBe(true);
		expect(reg.has("list_jobs")).toBe(true);
	});

	it("MiMoStack 暴露共享 JobRegistry", () => {
		const reg = new ToolRegistry();
		const stub = { streamChat: async function*() {} };
		const stack = createMiMoStack(stub, reg, process.cwd(), {});
		expect(stack.jobs).toBeDefined();
		expect(typeof stack.jobs.start).toBe("function");
	});

	it("run_background → wait_for_job 端到端", async () => {
		const reg = new ToolRegistry();
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, reg, process.cwd(), {});
		const started = await reg.execute({
			function: {
				name: "run_background",
				arguments: JSON.stringify({
					command: 'node -e "console.log(\\"hi\\")"',
					waitSec: 1,
				}),
			},
		});
		expect(started.content).toMatch(/job \d+/);
	}, 8000);
});
```

### Step 4: 跑全部

Run: `npm test`
Expected: 全绿(除已知 Windows 失败外)。`npm run typecheck`:0 error。

### Step 5: Commit

```bash
git add -A
git commit -m "feat(shell): wire shell + job tools into createMiMoStack with shared JobRegistry"
```

---

## 验收清单

- [ ] `src/tools/shell/` 含 9 个文件:parse.ts、shell-chain.ts、exec.ts、JobRegistry.ts、format.ts、ExecShellTool.ts(改写)、RunBackgroundTool.ts、JobOutputTool.ts、WaitForJobTool.ts、StopJobTool.ts、ListJobsTool.ts、index.ts
- [ ] `MiMoConfig.shell` 新字段含 timeoutSec / maxOutputChars / extraAllowed
- [ ] `createMiMoStack` 注册 6 个 shell 工具 + 暴露 stack.jobs
- [ ] `exec_shell` 在 Windows + Linux 都通(不再依赖 `sh`)
- [ ] `npm test` 全绿
- [ ] `npm run typecheck` 0 error
- [ ] 9 次或更少 commit,每个 Task 一组

## 与现有系统交互

- **ApprovalManager**:Task 5 / Task 6 的 `ExecShellTool` / `RunBackgroundTool` 在命令未通过 allowlist 时调 `approvalManager.checkApproval`。务必先 read `src/approval/ApprovalManager.ts` 第 79-134 行确认 `checkApproval` 的精确签名,适配工具调用处的入参形状。
- **ToolRateLimiter**:Wave 2a 已为 `exec_shell` 设置每 60s 60 次默认限流。新增 `run_background` 也应在 `DEFAULT_TOOL_RATE_LIMIT.tools` 加更严格的限制(比如 10/60s)——可选,留给后续微调。
- **StormBreaker**:Wave 1 时 StormBreaker 把 `read_file` / `list_directory` 等读工具标 `stormExempt`。新工具 `job_output` / `wait_for_job` / `list_jobs` 也应该是 stormExempt——但接收方目前的 StormBreaker 实现可能没暴露这个接口。读 `src/repair/StormBreaker.ts:isStormExempt` 决定要不要扩展。本计划**不要求**改 StormBreaker——若发现反复 poll job_output 触发风暴,作为后续优化。
