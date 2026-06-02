# Wave 2c — Code-Query:tree-sitter 符号查询

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DeepSeek-Reasonix 的 `code-query` 子系统(基于 web-tree-sitter 的语法感知符号提取与定位)移植到接收方。完成后接收方拥有两个新工具:`get_symbols`(列出单文件的函数/类/方法/类型等符号)、`find_in_code`(在单文件内按标识符精确查找,跳过注释/字符串),覆盖 TS/TSX/JS/JSX/Python/Go/Rust/Java 七种 grammar。

**Architecture:**
- 4 个底层模块 + 2 个 Tool 子类。底层模块(`parser.ts` / `grammar-map.ts` / `symbols.ts` / `find-in-code.ts`)可以 1:1 复制捐赠方代码,只动 import 和 grammar 路径解析逻辑。
- **延迟加载**(`lazy(() => import(...))` 模式):`web-tree-sitter` 是个 ~3MB 的 Emscripten 运行时,会话不调用代码查询时不应付出加载成本。把它放在 Tool 类的 `execute()` 第一次进入时才 `await import("./parser.js")`。
- **Grammar WASM 文件分发**:捐赠方在多个候选路径里探测(开发期从 npm 包根、生产期从 `dist/grammars/`)。接收方采用同一思路,加上 `build` 脚本把 WASM 拷贝到 `dist/grammars/`。

**Tech Stack:**
- 新增运行时依赖:`web-tree-sitter`(~3MB)
- 新增开发依赖(只为开发期能 require WASM):`tree-sitter-typescript`、`tree-sitter-javascript`、`tree-sitter-python`、`tree-sitter-go`、`tree-sitter-rust`、`tree-sitter-java`(每个 ~1-5MB,**全部为 devDependency**——生产期它们的 .wasm 文件会被 `scripts/copy-assets.mjs` 拷贝到 `dist/grammars/`)
- vitest、biome 不变

---

## 背景与设计抉择

### 为什么不能直接 `npm install` 解决?

捐赠方 `code-query/parser.ts:69-83` 在多个位置探测 WASM 文件:
1. 用户传入的 `grammarDir`
2. 全局 `setGrammarDir(...)` 指定的目录
3. 与 `parser.js` 同级或上级的 `grammars/` 目录
4. `tree-sitter-X/` npm 包根目录

接收方需要保留这个探测逻辑,因为开发期可以走 npm 包,**生产构建后**(`tsc → dist/`)则需要单独的 `dist/grammars/`。

### 与 `search/GrepTool` 的关系

接收方已有 `src/tools/search/GrepTool`(基于正则扫文件)。`find_in_code` 是它的**语法感知补充**:
- GrepTool:跨文件,文本匹配,可能假阳性(注释里有 `foo` 也算)
- CodeQueryTool:单文件,AST 匹配,跳过注释/字符串/字面量

模型应该把 `find_in_code` 当作精确查询的高准确度路径。

---

## 文件结构

### 新建

| 路径 | 来源 | 责任 |
|---|---|---|
| `src/tools/code-query/grammar-map.ts` | 捐赠方 `code-query/grammar-map.ts` 27 行 | 文件扩展名 → GrammarName 映射 |
| `src/tools/code-query/parser.ts` | 捐赠方 `code-query/parser.ts` 95 行 | tree-sitter 初始化 + WASM 路径探测 + Parser 单例 |
| `src/tools/code-query/symbols.ts` | 捐赠方 `code-query/symbols.ts` 189 行 | `extractSymbols` + 各 grammar 的符号查询字符串 |
| `src/tools/code-query/find-in-code.ts` | 捐赠方 `code-query/find-in-code.ts` 163 行 | `findInCode` + AST 上的标识符过滤 |
| `src/tools/code-query/SymbolsTool.ts` | 新建 | `get_symbols` Tool 子类(延迟加载) |
| `src/tools/code-query/CodeQueryTool.ts` | 新建 | `find_in_code` Tool 子类(延迟加载) |
| `src/tools/code-query/index.ts` | 新建 | barrel |
| `scripts/copy-grammars.mjs` | 新建 | 构建时把 `node_modules/tree-sitter-X/*.wasm` 拷贝到 `dist/grammars/` |

### 修改

| 路径 | 改动 |
|---|---|
| `package.json` | 加 `web-tree-sitter` 为 dependency,加 6 个 grammar 为 devDependency;`build` 脚本加 `&& node scripts/copy-grammars.mjs` |
| `scripts/copy-assets.mjs` | 若需要,把 grammar 拷贝合并进现有 copy-assets 而非单独脚本(由实现者决定) |
| `src/config/createMiMoStack.ts` | 工厂注册 SymbolsTool + CodeQueryTool 到 builtins |
| `src/tools/index.ts` | re-export 新工具 |

### 测试

| 路径 | 用例数 |
|---|---|
| `tests/unit/grammar-map.test.ts` | 3 |
| `tests/unit/code-symbols.test.ts` | ~6(基于真实小文件 fixture) |
| `tests/unit/code-find-in-code.test.ts` | ~5 |
| `tests/unit/code-query-tools.test.ts` | ~4 |
| `tests/fixtures/sample.ts`、`sample.py` 等 | 用作测试输入的小文件 |

---

## 移植注意事项

1. **`Parser.init` 的 `locateFile`** (捐赠方 `parser.ts:29-34`):用 `createRequire(import.meta.url)` 找 `web-tree-sitter/web-tree-sitter.wasm`。接收方保留这个机制——它本身不需要任何路径变更。

2. **Grammar 文件 fallback**:捐赠方按 `[overrideDir, resolvedGrammarDir, ../grammars/, ./grammars/, tree-sitter-X 包根]` 顺序探测。接收方在开发期主要走"tree-sitter-X 包根"分支(从 node_modules/),生产期走 "dist/grammars/"。具体落地:
   - 开发期:`npm test` 跑测试,parser.ts 的 fallback 会找到 `node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm`。
   - 生产期:`npm run build` 末尾跑 `scripts/copy-grammars.mjs` 把 `node_modules/tree-sitter-X/*.wasm` 拷贝到 `dist/grammars/`,运行时 parser.js 的 `fileURLToPath(import.meta.url)/../grammars/...` 分支生效。

3. **package.json 的 `files` 字段**:确保 `dist/grammars/` 被打包到 npm 发布的 tarball。检查现有 `files` 是否包含 `dist`。

4. **真实子进程 vs 单元测试**:tree-sitter 的初始化在 Node 22 上是同步可行的;不需要 spawn 子进程。所有测试都可以在 vitest 内同步跑(但要 `await` parser 加载)。

5. **测试 fixture 的稳定性**:`tests/fixtures/sample.ts` 等文件必须语法正确(否则 tree-sitter 解析失败、symbols 数组为空)。固定内容,不依赖外部生成。

---

## Task 1: 加依赖 + grammar 复制脚本

**Files:**
- Modify: `package.json`
- Create: `scripts/copy-grammars.mjs`

### Step 1: 加 package.json 依赖

```bash
npm install web-tree-sitter
npm install --save-dev tree-sitter-typescript tree-sitter-javascript tree-sitter-python tree-sitter-go tree-sitter-rust tree-sitter-java
```

> 警告:这些 grammar 包加起来大约 30-50MB。如果项目希望最小化依赖,可以只装 TS/JS/Python 三个(覆盖大多数场景),其它语言运行时会报"grammar not found"——`extractSymbols` 会回退到返回 `{ error: UNSUPPORTED }`。本计划默认装全 6 个。

### Step 2: 写 copy-grammars 脚本

`scripts/copy-grammars.mjs`:

```js
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const destDir = resolve(__dirname, "..", "dist", "grammars");
mkdirSync(destDir, { recursive: true });

const packages = [
	"tree-sitter-typescript",
	"tree-sitter-javascript",
	"tree-sitter-python",
	"tree-sitter-go",
	"tree-sitter-rust",
	"tree-sitter-java",
];

for (const pkg of packages) {
	let pkgRoot;
	try {
		pkgRoot = dirname(require.resolve(`${pkg}/package.json`));
	} catch {
		console.warn(`[copy-grammars] ${pkg} not installed — skipping`);
		continue;
	}
	// tree-sitter-typescript ships two wasm files (typescript + tsx);
	// others ship one. Pick up every *.wasm at the root level.
	const wasmFiles = readdirSync(pkgRoot).filter(f => f.endsWith(".wasm"));
	for (const w of wasmFiles) {
		const src = join(pkgRoot, w);
		const dst = join(destDir, w);
		copyFileSync(src, dst);
		console.log(`[copy-grammars] ${w} → dist/grammars/`);
	}
}
```

### Step 3: 把脚本接进 build

在 `package.json` 的 `scripts.build` 末尾追加:

```json
"build": "node node_modules/typescript/lib/tsc.js && node scripts/copy-assets.mjs && node scripts/copy-grammars.mjs"
```

### Step 4: 验证脚本能跑

Run: `node scripts/copy-grammars.mjs`
Expected: 控制台打印每个 grammar 文件被拷贝,`dist/grammars/` 出现 `tree-sitter-typescript.wasm` 等。

> 注:如果是首次跑(还没 `npm run build`),`dist/` 目录可能不存在;脚本里的 `mkdirSync({ recursive: true })` 会自动建。

### Step 5: Commit

```bash
git add package.json package-lock.json scripts/copy-grammars.mjs
git commit -m "build: add web-tree-sitter + grammar packages, copy WASM at build time"
```

---

## Task 2: 移植 `grammar-map.ts` 和 `parser.ts`

**Files:**
- Create: `src/tools/code-query/grammar-map.ts`
- Create: `src/tools/code-query/parser.ts`
- Test: `tests/unit/grammar-map.test.ts`

### Step 1: 写失败测试

`tests/unit/grammar-map.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { grammarForPath } from "../../src/tools/code-query/grammar-map.js";

describe("grammarForPath", () => {
	it(".ts 映射到 typescript", () => {
		expect(grammarForPath("foo.ts")).toBe("typescript");
	});
	it(".tsx 映射到 tsx", () => {
		expect(grammarForPath("foo.tsx")).toBe("tsx");
	});
	it(".py 映射到 python", () => {
		expect(grammarForPath("foo.py")).toBe("python");
	});
	it(".go 映射到 go", () => {
		expect(grammarForPath("a/b/c.go")).toBe("go");
	});
	it(".unknown 返回 null", () => {
		expect(grammarForPath("foo.unknown")).toBeNull();
	});
	it("大小写不敏感", () => {
		expect(grammarForPath("FOO.PY")).toBe("python");
	});
});
```

### Step 2: 跑测试预期 FAIL

### Step 3: 复制 grammar-map.ts

把 `tmp/DeepSeek-Reasonix-main/src/code-query/grammar-map.ts` 整文件复制到 `src/tools/code-query/grammar-map.ts`。**零改动**。

### Step 4: 复制 parser.ts

把 `tmp/DeepSeek-Reasonix-main/src/code-query/parser.ts` 复制到 `src/tools/code-query/parser.ts`。**零改动**——文件内的 import (`./grammar-map.js`)在新位置依然解析正确。grammar 路径探测逻辑(`resolveGrammarPath`)适用于接收方的目录布局:
- 开发期:fallback 链最后一档 `require.resolve("tree-sitter-typescript/package.json")` 成功,WASM 从 node_modules 加载。
- 生产期:fallback 链第三档 `fileURLToPath(import.meta.url)/../grammars/...`(等价于 `dist/grammars/`)生效——条件是 Task 1 的 `copy-grammars.mjs` 已跑。

### Step 5: 跑 grammar-map 测试

Run: `npm test -- tests/unit/grammar-map.test.ts`
Expected: 6/6 PASS。

### Step 6: typecheck

Run: `npm run typecheck`
Expected: 0 error。若报 `web-tree-sitter` 找不到类型,确认 Task 1 已运行 `npm install`。

### Step 7: Commit

```bash
git add src/tools/code-query/grammar-map.ts src/tools/code-query/parser.ts tests/unit/grammar-map.test.ts
git commit -m "feat(code-query): port grammar map + parser with WASM fallback chain"
```

---

## Task 3: 移植 `symbols.ts`

**Files:**
- Create: `src/tools/code-query/symbols.ts`
- Create: `tests/fixtures/sample.ts`、`tests/fixtures/sample.py`
- Test: `tests/unit/code-symbols.test.ts`

### Step 1: 创建 fixture 文件

`tests/fixtures/sample.ts`:

```ts
export function topLevel(): number {
	return 42;
}

export class Foo {
	bar(): string {
		return "hi";
	}
	private internal(): void {}
}

export interface Iface {
	x: number;
}

export type Alias = number | string;

export enum Color {
	Red,
	Green,
}
```

`tests/fixtures/sample.py`:

```py
def top_level():
    return 42

class MyClass:
    def method_a(self):
        pass

    def method_b(self):
        return 1
```

### Step 2: 写失败测试

`tests/unit/code-symbols.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { extractSymbols } from "../../src/tools/code-query/symbols.js";

const tsFixture = path.resolve("tests/fixtures/sample.ts");
const pyFixture = path.resolve("tests/fixtures/sample.py");

describe("extractSymbols", () => {
	it("识别 TS 顶层函数/类/接口/类型/枚举", async () => {
		const src = await readFile(tsFixture, "utf-8");
		const symbols = await extractSymbols(tsFixture, src);
		const names = symbols.map(s => s.name);
		expect(names).toContain("topLevel");
		expect(names).toContain("Foo");
		expect(names).toContain("Iface");
		expect(names).toContain("Alias");
		expect(names).toContain("Color");
	}, 15000);

	it("方法挂在 class parent 下", async () => {
		const src = await readFile(tsFixture, "utf-8");
		const symbols = await extractSymbols(tsFixture, src);
		const bar = symbols.find(s => s.name === "bar");
		expect(bar?.kind).toBe("method");
		expect(bar?.parent).toBe("Foo");
	}, 15000);

	it("Python 函数 + 类", async () => {
		const src = await readFile(pyFixture, "utf-8");
		const symbols = await extractSymbols(pyFixture, src);
		const names = symbols.map(s => s.name);
		expect(names).toContain("top_level");
		expect(names).toContain("MyClass");
	}, 15000);

	it("不支持的扩展名 → 空数组", async () => {
		const symbols = await extractSymbols("foo.unknown", "irrelevant");
		expect(symbols).toEqual([]);
	});

	it("行号 column 都是 1-based", async () => {
		const src = await readFile(tsFixture, "utf-8");
		const symbols = await extractSymbols(tsFixture, src);
		const top = symbols.find(s => s.name === "topLevel");
		expect(top?.line).toBeGreaterThanOrEqual(1);
		expect(top?.column).toBeGreaterThanOrEqual(1);
	}, 15000);
});
```

### Step 3: 跑测试预期 FAIL(模块不存在)

### Step 4: 复制 symbols.ts

把 `tmp/DeepSeek-Reasonix-main/src/code-query/symbols.ts` 复制到 `src/tools/code-query/symbols.ts`。**零改动**——其 import (`./parser.js`)在新位置依然正确。

### Step 5: 跑测试

Run: `npm test -- tests/unit/code-symbols.test.ts`
Expected: 5/5 PASS。

> 若 Python 测试失败,确认 `tree-sitter-python` 已装(`ls node_modules/tree-sitter-python/*.wasm`)。若 TS 测试失败,确认 `tree-sitter-typescript` 装上,且 wasm 文件名是 `tree-sitter-typescript.wasm` 而非 `tree-sitter-tsx.wasm`(后者也存在,parser 会按 grammar name 选)。

### Step 6: Commit

```bash
git add src/tools/code-query/symbols.ts tests/fixtures/sample.ts tests/fixtures/sample.py tests/unit/code-symbols.test.ts
git commit -m "feat(code-query): port symbol extractor (TS/JS/Python/Go/Rust/Java)"
```

---

## Task 4: 移植 `find-in-code.ts`

**Files:**
- Create: `src/tools/code-query/find-in-code.ts`
- Test: `tests/unit/code-find-in-code.test.ts`

### Step 1: 写失败测试

`tests/unit/code-find-in-code.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { findInCode } from "../../src/tools/code-query/find-in-code.js";

const tsFixture = path.resolve("tests/fixtures/sample.ts");

describe("findInCode", () => {
	it("'topLevel' 作为函数声明被识别", async () => {
		const src = await readFile(tsFixture, "utf-8");
		const m = await findInCode(tsFixture, src, "topLevel");
		expect(m.length).toBeGreaterThan(0);
		expect(m.some(x => x.kind === "definition")).toBe(true);
	}, 15000);

	it("不存在的标识符返回空数组", async () => {
		const src = await readFile(tsFixture, "utf-8");
		const m = await findInCode(tsFixture, src, "nonExistent");
		expect(m).toEqual([]);
	}, 15000);

	it("kind=definition 过滤", async () => {
		const src = await readFile(tsFixture, "utf-8");
		const m = await findInCode(tsFixture, src, "Foo", { kind: "definition" });
		expect(m.length).toBe(1);
		expect(m[0]!.kind).toBe("definition");
	}, 15000);

	it("snippet 是单行,包含命中行的文本", async () => {
		const src = await readFile(tsFixture, "utf-8");
		const m = await findInCode(tsFixture, src, "topLevel");
		const def = m.find(x => x.kind === "definition");
		expect(def?.snippet).toContain("topLevel");
	}, 15000);

	it("不支持的扩展名 → 空数组", async () => {
		const m = await findInCode("foo.unknown", "irrelevant", "x");
		expect(m).toEqual([]);
	});
});
```

### Step 2: 跑测试预期 FAIL

### Step 3: 复制 find-in-code.ts

把 `tmp/DeepSeek-Reasonix-main/src/code-query/find-in-code.ts` 复制到 `src/tools/code-query/find-in-code.ts`。**零改动**。

### Step 4: 跑测试

Run: `npm test -- tests/unit/code-find-in-code.test.ts`
Expected: 5/5 PASS。

### Step 5: Commit

```bash
git add src/tools/code-query/find-in-code.ts tests/unit/code-find-in-code.test.ts
git commit -m "feat(code-query): port findInCode with AST-aware identifier matching"
```

---

## Task 5: 两个 Tool 子类(SymbolsTool / CodeQueryTool)

**Files:**
- Create: `src/tools/code-query/SymbolsTool.ts`
- Create: `src/tools/code-query/CodeQueryTool.ts`
- Create: `src/tools/code-query/index.ts`
- Test: `tests/unit/code-query-tools.test.ts`

### Step 1: 写失败测试

`tests/unit/code-query-tools.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SymbolsTool } from "../../src/tools/code-query/SymbolsTool.js";
import { CodeQueryTool } from "../../src/tools/code-query/CodeQueryTool.js";

describe("SymbolsTool / CodeQueryTool", () => {
	it("SymbolsTool.execute 返回 JSON 字符串", async () => {
		const tool = new SymbolsTool({ rootDir: process.cwd() });
		const out = await tool.execute({ path: "tests/fixtures/sample.ts" });
		const parsed = JSON.parse(out);
		expect(parsed.path).toBe("tests/fixtures/sample.ts");
		expect(Array.isArray(parsed.symbols)).toBe(true);
		expect(parsed.symbols.length).toBeGreaterThan(0);
	}, 15000);

	it("SymbolsTool 不支持的语言返回 error", async () => {
		const tool = new SymbolsTool({ rootDir: process.cwd() });
		const out = await tool.execute({ path: "tests/fixtures/nothing.unknown" });
		const parsed = JSON.parse(out);
		expect(parsed.error).toMatch(/not supported/i);
	});

	it("CodeQueryTool 找到 topLevel 函数声明", async () => {
		const tool = new CodeQueryTool({ rootDir: process.cwd() });
		const out = await tool.execute({
			name: "topLevel",
			path: "tests/fixtures/sample.ts",
		});
		const parsed = JSON.parse(out);
		expect(parsed.matches.length).toBeGreaterThan(0);
	}, 15000);

	it("getDefinition 暴露正确字段", () => {
		const s = new SymbolsTool({ rootDir: "/" });
		expect(s.getDefinition().name).toBe("get_symbols");
		expect(s.getDefinition().parameters.required).toEqual(["path"]);
		const f = new CodeQueryTool({ rootDir: "/" });
		expect(f.getDefinition().name).toBe("find_in_code");
		expect(f.getDefinition().parameters.required).toEqual(["name", "path"]);
	});
});
```

### Step 2: 跑测试预期 FAIL

### Step 3: 实现 SymbolsTool

`src/tools/code-query/SymbolsTool.ts`:

```ts
import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";

const UNSUPPORTED =
	"language not supported (TS/TSX/JS/JSX/Python/Go/Rust/Java); use grep / search for text-level matching";

export interface SymbolsToolOptions {
	rootDir: string;
}

/**
 * SymbolsTool — outline 单文件的顶层 + 嵌套符号(函数/类/方法/接口/类型/枚举/命名空间)。
 * web-tree-sitter 延迟加载——会话不调用此工具时不付出 ~3MB Emscripten 运行时的成本。
 */
export class SymbolsTool {
	name = "get_symbols";
	description =
		"Outline a single TS/TSX/JS/JSX/Python/Go/Rust/Java file via tree-sitter. Returns top-level + nested symbols (functions, classes, methods, interfaces, types, enums, namespaces) with 1-based line/column. Grammar-aware: skips matches inside comments/strings. Use for 'what's in this file'; for cross-file scans use grep.";

	private readonly rootDir: string;

	constructor(options: SymbolsToolOptions) {
		this.rootDir = pathResolve(options.rootDir);
	}

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "File path (relative to project root or absolute).",
					},
				},
				required: ["path"],
			},
		};
	}

	async execute(args: Record<string, any>): Promise<string> {
		const rawPath = typeof args.path === "string" ? args.path : "";
		const filePath = this.resolveProjectPath(rawPath);
		const { grammarForPath } = await import("./grammar-map.js");
		if (!grammarForPath(filePath)) {
			return JSON.stringify({ path: rawPath, error: UNSUPPORTED });
		}
		const source = await readFile(filePath, "utf8");
		const { extractSymbols } = await import("./symbols.js");
		const symbols = await extractSymbols(filePath, source);
		return JSON.stringify({ path: rawPath, symbols });
	}

	private resolveProjectPath(raw: string): string {
		const stripped = raw.replace(/^[/\\]+/, "");
		return pathResolve(this.rootDir, stripped.length === 0 ? "." : stripped);
	}
}
```

### Step 4: 实现 CodeQueryTool

`src/tools/code-query/CodeQueryTool.ts`:

```ts
import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";

const UNSUPPORTED =
	"language not supported (TS/TSX/JS/JSX/Python/Go/Rust/Java); use grep / search for text-level matching";

export interface CodeQueryToolOptions {
	rootDir: string;
}

/**
 * CodeQueryTool — 在单文件内按标识符精确查找,AST 过滤注释/字符串。
 * `kind` 限定:call / definition / reference / any(默认)。
 */
export class CodeQueryTool {
	name = "find_in_code";
	description =
		"Find identifier `name` in a single TS/TSX/JS/JSX/Python/Go/Rust/Java file, AST-filtered (skips matches inside comments and strings). Optional `kind` narrows by syntactic role. Within-file only — does NOT resolve cross-file references; for that, use grep + reading.";

	private readonly rootDir: string;

	constructor(options: CodeQueryToolOptions) {
		this.rootDir = pathResolve(options.rootDir);
	}

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					name: { type: "string", description: "Exact identifier text to find." },
					path: {
						type: "string",
						description: "File path (relative to project root or absolute).",
					},
					kind: {
						type: "string",
						enum: ["any", "call", "definition", "reference"],
						description: "Filter by syntactic role. Default 'any'.",
					},
				},
				required: ["name", "path"],
			},
		};
	}

	async execute(args: Record<string, any>): Promise<string> {
		const rawPath = typeof args.path === "string" ? args.path : "";
		const name = typeof args.name === "string" ? args.name : "";
		const kindArg = typeof args.kind === "string" ? args.kind : "any";
		const filePath = this.resolveProjectPath(rawPath);
		const { grammarForPath } = await import("./grammar-map.js");
		if (!grammarForPath(filePath)) {
			return JSON.stringify({ path: rawPath, error: UNSUPPORTED });
		}
		const source = await readFile(filePath, "utf8");
		const { findInCode } = await import("./find-in-code.js");
		const findOpts = kindArg === "any" ? {} : { kind: kindArg as "call" | "definition" | "reference" };
		const matches = await findInCode(filePath, source, name, findOpts);
		return JSON.stringify({ path: rawPath, matches });
	}

	private resolveProjectPath(raw: string): string {
		const stripped = raw.replace(/^[/\\]+/, "");
		return pathResolve(this.rootDir, stripped.length === 0 ? "." : stripped);
	}
}
```

### Step 5: barrel `index.ts`

`src/tools/code-query/index.ts`:

```ts
export { SymbolsTool } from "./SymbolsTool.js";
export { CodeQueryTool } from "./CodeQueryTool.js";
export type { SymbolKind, CodeSymbol } from "./symbols.js";
export type { CodeMatchKind, CodeMatch, FindInCodeOptions } from "./find-in-code.js";
export type { GrammarName } from "./grammar-map.js";
```

### Step 6: 跑测试

Run: `npm test -- tests/unit/code-query-tools.test.ts`
Expected: 4/4 PASS。

### Step 7: Commit

```bash
git add src/tools/code-query tests/unit/code-query-tools.test.ts
git commit -m "feat(code-query): add SymbolsTool + CodeQueryTool with lazy tree-sitter loading"
```

---

## Task 6: 工厂注册 + 集成测试

**Files:**
- Modify: `src/config/createMiMoStack.ts`
- Modify: `src/tools/index.ts`
- Test: `tests/integration/wave2c-code-query.test.ts`

### Step 1: 集成测试

`tests/integration/wave2c-code-query.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMiMoStack } from "../../src/config/createMiMoStack.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";

describe("Wave 2c 端到端 — code-query 工具注册到工厂", () => {
	it("get_symbols + find_in_code 都被注册", () => {
		const reg = new ToolRegistry();
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, reg, process.cwd(), {});
		expect(reg.has("get_symbols")).toBe(true);
		expect(reg.has("find_in_code")).toBe(true);
	});

	it("通过 registry 调 get_symbols 拿到 sample.ts 的符号", async () => {
		const reg = new ToolRegistry();
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, reg, process.cwd(), {});
		const res = await reg.execute({
			function: {
				name: "get_symbols",
				arguments: JSON.stringify({ path: "tests/fixtures/sample.ts" }),
			},
		});
		const parsed = JSON.parse(res.content);
		expect(parsed.symbols.length).toBeGreaterThan(0);
	}, 15000);

	it("find_in_code 通过 registry 工作", async () => {
		const reg = new ToolRegistry();
		const stub = { streamChat: async function*() {} };
		createMiMoStack(stub, reg, process.cwd(), {});
		const res = await reg.execute({
			function: {
				name: "find_in_code",
				arguments: JSON.stringify({
					name: "topLevel",
					path: "tests/fixtures/sample.ts",
				}),
			},
		});
		const parsed = JSON.parse(res.content);
		expect(parsed.matches.length).toBeGreaterThan(0);
	}, 15000);
});
```

### Step 2: 改 `createMiMoStack`

在 `createMiMoStack.ts` 顶部加 import:

```ts
import { SymbolsTool } from "../tools/code-query/SymbolsTool.js";
import { CodeQueryTool } from "../tools/code-query/CodeQueryTool.js";
```

把 `builtins` 数组扩充:

```ts
const builtins = [
	new TodoWriteTool(),
	new ApplyPatchTool(),
	new ChoiceTool({ gate: deps.confirmationGate }),
	// ... Wave 2b 的 shell 工具(如已落地)
	new SymbolsTool({ rootDir: workingDirectory }),
	new CodeQueryTool({ rootDir: workingDirectory }),
] as const;
```

### Step 3: 改 `src/tools/index.ts`

在末尾追加:

```ts
export { SymbolsTool, CodeQueryTool } from "./code-query/index.js";
export type {
	SymbolKind,
	CodeSymbol,
	CodeMatchKind,
	CodeMatch,
	FindInCodeOptions,
	GrammarName,
} from "./code-query/index.js";
```

### Step 4: 跑全部

Run: `npm test`
Expected: 全绿(除已知 Windows 失败)。`npm run typecheck`:0 error。

### Step 5: Commit

```bash
git add -A
git commit -m "feat(code-query): register SymbolsTool + CodeQueryTool in createMiMoStack"
```

---

## 验收清单

- [ ] `src/tools/code-query/` 含 7 个文件(grammar-map / parser / symbols / find-in-code / SymbolsTool / CodeQueryTool / index)
- [ ] `scripts/copy-grammars.mjs` 可独立跑,产出 `dist/grammars/*.wasm`
- [ ] `package.json.scripts.build` 末尾接 `node scripts/copy-grammars.mjs`
- [ ] `package.json.dependencies` 含 `web-tree-sitter`
- [ ] `package.json.devDependencies` 含 6 个 `tree-sitter-X` 包
- [ ] `createMiMoStack` 注册 `get_symbols` + `find_in_code`
- [ ] `tests/fixtures/sample.ts`、`sample.py` 存在
- [ ] `npm test` 通过(新加用例总计 ~23 个)
- [ ] `npm run typecheck` 0 error

---

## 已知风险与缓解

1. **node_modules 体积膨胀**:6 个 grammar 加 web-tree-sitter ≈ 30-50MB。如果项目对 install 时间或 npm pack 体积敏感,可以:
   - 把全部 6 个 grammar 改为 `optionalDependencies`,运行时 `require.resolve` 失败时 `extractSymbols` 返回 `error: UNSUPPORTED`(代码已有此路径)
   - 或者只装 TS/JS/Python 三个,其它语言用户自行 install

2. **WASM 文件命名差异**:不同 grammar 包的 wasm 命名规则可能不一致(`tree-sitter-typescript` 出两个:`tree-sitter-typescript.wasm` + `tree-sitter-tsx.wasm`)。`copy-grammars.mjs` 用 `readdirSync` 兜底——但 Task 1 完成后人工 verify 一遍 `dist/grammars/` 内容,确认 7 个 grammar 对应的 wasm 都在。

3. **vitest test fixture 解析**:`extractSymbols` 第一次调用时要加载 tree-sitter wasm,耗时几百 ms。所有相关测试加 `15000` ms 超时(已加)。

4. **未来扩展(暂不实施)**:
   - 跨文件符号索引(类似 LSP workspaceSymbols)——本计划不做
   - tree-sitter incremental parsing(reuse trees across edits)——本计划不做
   - 更多 grammar(C++ / C# / Ruby / PHP 等)——后续按需追加,套同样的模式

---

## 与 Wave 2a/2b 的集成顺序

可以**与 Wave 2b 并行执行**——code-query 与 shell/jobs 没有共享代码或依赖。但若 Wave 2b 已先落地,Task 6 的 `createMiMoStack` builtins 数组要保留 2b 加的 shell 工具,只在末尾追加 SymbolsTool/CodeQueryTool。

实施完毕后,接收方的 `createMiMoStack` builtins 应含约 11-12 个工具:
- Wave 1:TodoWriteTool, ApplyPatchTool, ChoiceTool
- Wave 2b:ExecShellTool, RunBackgroundTool, JobOutputTool, WaitForJobTool, StopJobTool, ListJobsTool
- Wave 2c:SymbolsTool, CodeQueryTool
