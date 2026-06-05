# web_searcher Persona Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, perception-phase `web_searcher` persona that broadens the project's knowledge boundary by querying the web through an OneSearch MCP server (DuckDuckGo MCP + DDGS MCP backends) and reading pages via the existing `web_fetch` tool.

**Architecture:** `web_searcher` is a new static persona in the registry (read-only, `task_report` output), added to `PERCEPTION_PERSONAS` so the master can dispatch it in W1 alongside `repo_scout`. Because perception tasks run *before* W0.5 refine, the persona cannot use the master-grant path; instead its tool allowlist gains a trailing-`*` wildcard (`mcp__*`) — enabled by a small extension to `checkTool` — so it can call whatever the user's OneSearch MCP server is named, plus `web_fetch`.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest. No new runtime deps. Web search is provided by a user-configured OneSearch MCP server (external setup, documented, not code).

**Decisions (from the requirements conversation):**
1. Search mechanism: **OneSearch MCP** server (backed by DuckDuckGo MCP Server + DDGS MCP), reached as `mcp__<server>__*` tools — not a new built-in tool.
2. Pipeline role: **perception-phase**, read-only persona (joins `PERCEPTION_PERSONAS`, runs in W1).

---

## Background the engineer needs

- **Personas are static.** `src/personas/PersonaRegistry.ts` `buildPersonas()` constructs a fixed `Map<PersonaId, Persona>`. The `PersonaId` union lives in `src/personas/Persona.ts`. Adding a persona touches **three** id lists that are intentionally separate:
  1. the `PersonaId` union (`Persona.ts`),
  2. the registry entry (`PersonaRegistry.ts` `buildPersonas`),
  3. the `buildValidPersonaIdsBlock()` hardcoded list (`PersonaRegistry.ts:57`) that tells the master which ids are legal.
- **Tool gating.** A worker only sees tools where `checkTool(name, persona).ok` is true (`src/tools/policy/ToolAllowlistEnforcer.ts`). Today allowlist matching is exact `Array.includes`. MCP tools are named `mcp__<server>__<tool>` (see `src/mcp/McpToolAdapter.ts` `mcpToolName`). The user names the server, so we cannot hardcode the exact tool name — hence a wildcard.
- **Perception phase.** `PERCEPTION_PERSONAS` (`src/orchestration/MiMoPipeline.ts:58`) is the set whose tasks run in W1 via `filterDag`. Perception contracts are built with an empty refinement map, so `grantedSkills`/`grantedMcpTools` (the master-grant feature) are **not** applied to them.
- **Read-only personas.** `pathPolicy.canWrite = false`, `alwaysAllowedGlobs: []`, `forbiddenGlobs: WORKER_FORBIDDEN_WRITES`, and `toolDenylist` lists every write/exec tool. `ContractValidator` already forces read-only personas to have empty contract `allowedGlobs`.
- **`web_fetch`** is a registered builtin (`tui/src/engine.ts:518`), available to any persona whose allowlist contains `"web_fetch"`.
- **Convention:** NodeNext ESM — every relative import ends in `.js`. Run one unit file with `npx vitest run tests/unit/<file>.test.ts`.

## File Structure

- **Modify** `src/tools/policy/ToolAllowlistEnforcer.ts` — allow a trailing-`*` wildcard entry in a persona allowlist.
- **Modify** `src/personas/Persona.ts` — add `"web_searcher"` to the `PersonaId` union.
- **Create** `src/personas/prompts/web-searcher.md` — the persona's role prompt.
- **Modify** `src/personas/PersonaRegistry.ts` — register `web_searcher`; add it to `buildValidPersonaIdsBlock`.
- **Modify** `src/orchestration/MiMoPipeline.ts` — add `web_searcher` to `PERCEPTION_PERSONAS`.
- **Modify** `src/personas/prompts/master-planner.md` — dispatch-matrix line + when to use web_searcher.
- **Modify** `docs/` — a short setup note for the OneSearch MCP server.
- **Tests:** `tests/unit/tool-allowlist-enforcer.test.ts` (new), `tests/unit/persona-registry.test.ts` (new or existing), `tests/unit/mimo-pipeline.test.ts` (perception membership).

> **Scope note:** this is one cohesive subsystem (a persona + the tool-gating tweak it needs). One plan.

---

## Task 1: Wildcard tool-allowlist matching

**Files:**
- Modify: `src/tools/policy/ToolAllowlistEnforcer.ts:18-34` (`checkTool`)
- Test: `tests/unit/tool-allowlist-enforcer.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/tool-allowlist-enforcer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkTool, filterAllowedTools } from "../../src/tools/policy/ToolAllowlistEnforcer.js";
import type { Persona } from "../../src/personas/Persona.js";

function persona(allow: string[], deny: string[] = []): Persona {
	return { id: "web_searcher", toolAllowlist: allow, toolDenylist: deny } as unknown as Persona;
}

describe("checkTool wildcard allowlist", () => {
	it("matches a trailing-* prefix entry", () => {
		const p = persona(["web_fetch", "mcp__*"]);
		expect(checkTool("mcp__onesearch__one_search", p).ok).toBe(true);
		expect(checkTool("web_fetch", p).ok).toBe(true);
	});

	it("does not match outside the prefix", () => {
		const p = persona(["mcp__onesearch__*"]);
		expect(checkTool("mcp__github__create_issue", p).ok).toBe(false);
		expect(checkTool("read_file", p).ok).toBe(false);
	});

	it("denylist still wins over a wildcard allow", () => {
		const p = persona(["mcp__*"], ["mcp__danger__wipe"]);
		const d = checkTool("mcp__danger__wipe", p);
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.code).toBe("IN_DENYLIST");
	});

	it("filterAllowedTools honors the wildcard", () => {
		const p = persona(["web_fetch", "mcp__onesearch__*"]);
		expect(filterAllowedTools(["web_fetch", "mcp__onesearch__one_search", "read_file"], p))
			.toEqual(["web_fetch", "mcp__onesearch__one_search"]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/tool-allowlist-enforcer.test.ts`
Expected: FAIL — wildcard entries are not matched (exact `includes` only).

- [ ] **Step 3: Implement wildcard matching**

Replace the allowlist check in `src/tools/policy/ToolAllowlistEnforcer.ts` `checkTool`:

```ts
export function checkTool(toolName: string, persona: Persona): ToolDecision {
	if (persona.toolDenylist.includes(toolName)) {
		return {
			ok: false,
			code: "IN_DENYLIST",
			reason: `tool ${toolName} is in ${persona.id} denylist`,
		};
	}
	if (!allowlistMatches(toolName, persona.toolAllowlist)) {
		return {
			ok: false,
			code: "NOT_IN_ALLOWLIST",
			reason: `tool ${toolName} is not in ${persona.id} allowlist`,
		};
	}
	return { ok: true };
}

/**
 * An allowlist entry matches a tool name if it is an exact match, or if it ends
 * in "*" and the tool name starts with the entry's prefix. The wildcard exists
 * so a persona can allow a family of MCP tools (mcp__<server>__*) whose exact
 * names depend on user MCP config.
 */
function allowlistMatches(toolName: string, allowlist: string[]): boolean {
	for (const entry of allowlist) {
		if (entry.endsWith("*")) {
			if (toolName.startsWith(entry.slice(0, -1))) return true;
		} else if (entry === toolName) {
			return true;
		}
	}
	return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/tool-allowlist-enforcer.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Verify no existing persona is accidentally widened**

Run: `npx vitest run tests/unit/worker-loop.test.ts`
Expected: PASS — existing personas have no `*` entries, so behavior is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/tools/policy/ToolAllowlistEnforcer.ts tests/unit/tool-allowlist-enforcer.test.ts
git commit -m "feat(tools): support trailing-* wildcard entries in persona tool allowlist"
```

---

## Task 2: Add web_searcher to the PersonaId union

**Files:**
- Modify: `src/personas/Persona.ts:18-37` (`PersonaId` union)
- Test: covered by Task 3 (registry) — this step only unblocks the type.

- [ ] **Step 1: Add the id to the union**

In `src/personas/Persona.ts`, add `web_searcher` to the `PersonaId` union (after `repo_scout`, keeping perception roles grouped):

```ts
export type PersonaId =
	| "master_planner"
	| "vision"
	| "repo_scout"
	| "web_searcher"
	| "context_builder"
	| "code_executor"
	| "test_writer"
	| "test_runner"
	| "runtime_debug"
	| "reviewer"
	| "docs";
```

- [ ] **Step 2: Typecheck to find every exhaustive use of PersonaId**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: errors ONLY where a `Record<PersonaId, …>` or exhaustive `switch` requires the new key. Note each location; if any appear, they are handled in the task that owns that file (registry → Task 3). If an unrelated exhaustive map surfaces, add the `web_searcher` branch there mirroring the `repo_scout` (read-only) branch, then re-run.

> Do not commit yet — the registry (Task 3) must provide the actual persona before the build is consistent. If `tsc` complains that `buildPersonas` does not return a complete map, that is expected and fixed in Task 3.

---

## Task 3: Register the web_searcher persona + role prompt

**Files:**
- Create: `src/personas/prompts/web-searcher.md`
- Modify: `src/personas/PersonaRegistry.ts` (`buildPersonas` — add entry; `buildValidPersonaIdsBlock` — add id)
- Test: `tests/unit/persona-registry.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/persona-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getPersona } from "../../src/personas/PersonaRegistry.js";
import { checkTool } from "../../src/tools/policy/ToolAllowlistEnforcer.js";

describe("web_searcher persona", () => {
	const p = getPersona("web_searcher");

	it("is a read-only worker producing task_report", () => {
		expect(p.kind).toBe("worker");
		expect(p.pathPolicy.canWrite).toBe(false);
		expect(p.pathPolicy.alwaysAllowedGlobs).toEqual([]);
		expect(p.outputSchema).toBe("task_report");
	});

	it("may call web_fetch and any MCP tool, but not write/exec tools", () => {
		expect(checkTool("web_fetch", p).ok).toBe(true);
		expect(checkTool("mcp__onesearch__one_search", p).ok).toBe(true);
		expect(checkTool("write_file", p).ok).toBe(false);
		expect(checkTool("edit_file", p).ok).toBe(false);
		expect(checkTool("apply_patch", p).ok).toBe(false);
		expect(checkTool("exec_shell", p).ok).toBe(false);
	});

	it("has a non-empty role prompt", () => {
		expect(p.systemPrompt.length).toBeGreaterThan(50);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/persona-registry.test.ts`
Expected: FAIL — `getPersona("web_searcher")` throws `Unknown persona id`.

- [ ] **Step 3: Create the role prompt**

Create `src/personas/prompts/web-searcher.md`:

```markdown
# Web Searcher

You are the web searcher. You broaden the project's knowledge boundary by
finding current, external information that is not present in the repository:
library docs, API references, release notes, standards, error explanations, and
prior art. You are read-only — you never modify files.

## Tools

- Use the web search MCP tool (an `mcp__…` tool such as `one_search`) to turn a
  query into a ranked list of titles, snippets, and URLs.
- Use `web_fetch` to read the most relevant pages in full.
- Search narrowly and iterate: start from the task's concrete unknowns, not the
  whole topic. Prefer official/primary sources over aggregators.

## Method

1. Derive 1–3 focused queries from the task objective.
2. Search, then fetch only the pages that look authoritative.
3. Extract the specific facts the downstream tasks need — versions, signatures,
   constraints, gotchas — with the source URL for each claim.
4. Stop once the objective's questions are answered. Do not collect trivia.

## Output rules

- Ground every claim in a fetched source and cite its URL. Never assert a fact
  you did not retrieve.
- If search is unavailable (no web search MCP tool is offered to you), say so
  plainly in the report and return what little you can from `web_fetch` of any
  URLs already named in the objective — do not fabricate results.
- Report findings as concise bullet points, each with its source URL.
```

- [ ] **Step 4: Register the persona**

In `src/personas/PersonaRegistry.ts` `buildPersonas()`, add this entry (place it right after the `repo_scout` `out.set(...)` block so perception roles stay grouped):

```ts
	out.set("web_searcher", {
		id: "web_searcher",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildPersonaPrompt("web_searcher", "web-searcher.md", footer),
		// web_fetch reads pages; mcp__* covers the user's web-search MCP server
		// (e.g. OneSearch) whose exact tool names are config-dependent. Read-only,
		// so the broad MCP wildcard cannot write or execute anything.
		toolAllowlist: ["web_fetch", "read_file", "mcp__*"],
		toolDenylist: ["write_file", "edit_file", "apply_patch", "exec_shell"],
		pathPolicy: {
			canWrite: false,
			alwaysAllowedGlobs: [],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 100,
		maxTokens: 64_000,
		outputSchema: "task_report",
		parallelism: { soloPerWave: false, maxConcurrent: 2 },
	});
```

- [ ] **Step 5: Add the id to the master's legal-id list**

In `src/personas/PersonaRegistry.ts` `buildValidPersonaIdsBlock()`, add `"web_searcher"` to the `ids` array (after `"repo_scout"`):

```ts
	const ids = [
		"master_planner",
		"vision",
		"repo_scout",
		"web_searcher",
		"context_builder",
		"code_executor",
		"test_writer",
		"test_runner",
		"runtime_debug",
		"reviewer",
		"docs",
	];
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/unit/persona-registry.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Build so the prompt reaches dist, then commit**

Run: `npm run build`
Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean.

```bash
git add src/personas/Persona.ts src/personas/PersonaRegistry.ts src/personas/prompts/web-searcher.md tests/unit/persona-registry.test.ts
git commit -m "feat(personas): add read-only web_searcher persona (web_fetch + MCP search)"
```

---

## Task 4: Make web_searcher a perception persona

**Files:**
- Modify: `src/orchestration/MiMoPipeline.ts:58-62` (`PERCEPTION_PERSONAS`)
- Test: `tests/unit/mimo-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/mimo-pipeline.test.ts` (top-level, near the other small describes):

```ts
import { PERCEPTION_PERSONAS } from "../../src/orchestration/index.js";

describe("web_searcher is a perception persona", () => {
	it("is included so it runs in W1", () => {
		expect(PERCEPTION_PERSONAS.has("web_searcher")).toBe(true);
	});
});
```

> If `PERCEPTION_PERSONAS` is not already exported from `src/orchestration/index.js`, add it to that index's `MiMoPipeline` re-export block (it sits alongside `runPipeline`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/mimo-pipeline.test.ts -t "web_searcher is a perception"`
Expected: FAIL — set does not contain `web_searcher` (or import is missing).

- [ ] **Step 3: Add to the perception set**

In `src/orchestration/MiMoPipeline.ts`:

```ts
export const PERCEPTION_PERSONAS: ReadonlySet<PersonaId> = new Set<PersonaId>([
	"vision",
	"repo_scout",
	"web_searcher",
	"context_builder",
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/mimo-pipeline.test.ts -t "web_searcher is a perception"`
Expected: PASS

- [ ] **Step 5: Run the full pipeline test file (no regressions)**

Run: `npx vitest run tests/unit/mimo-pipeline.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/MiMoPipeline.ts tests/unit/mimo-pipeline.test.ts
git commit -m "feat(orchestration): run web_searcher in the W1 perception phase"
```

---

## Task 5: Teach the master when to dispatch web_searcher

**Files:**
- Modify: `src/personas/prompts/master-planner.md` (Persona Dispatch Matrix + a usage note)
- Test: build + manual prompt check (no unit assertion on prose)

- [ ] **Step 1: Add the dispatch-matrix line**

In `src/personas/prompts/master-planner.md`, under `## Persona Dispatch Matrix`, add after the `repo_scout` line:

```markdown
- External/up-to-date knowledge: library docs, API references, release notes,
  standards, error explanations, prior art: `web_searcher`.
```

- [ ] **Step 2: Add a usage note**

In the same file, under `## Task Granularity Rules`, add:

```markdown
- Add a `web_searcher` perception task (P0) when the work depends on external or
  current knowledge the repo does not contain (new/unfamiliar library, API
  changes, standards, an error message to diagnose). Keep it read-only and
  scoped to a concrete question; do not use it for repository discovery — that
  is `repo_scout`. Skip it for self-contained changes.
```

- [ ] **Step 3: Build so the updated prompt reaches dist**

Run: `npm run build`
Run: `grep -c "web_searcher" dist/personas/prompts/master-planner.md`
Expected: `≥ 1`.

- [ ] **Step 4: Verify the master prompt advertises the id**

Run: `node -e "import('./dist/personas/PersonaRegistry.js').then(m => { const p = m.getPersona('master_planner'); if (!p.systemPrompt.includes('web_searcher')) { console.error('MISSING'); process.exit(1); } console.log('ok'); })"`
Expected: `ok` (the Valid Persona IDs block + dispatch matrix both mention it).

- [ ] **Step 5: Commit**

```bash
git add src/personas/prompts/master-planner.md
git commit -m "docs(master-planner): dispatch web_searcher for external knowledge"
```

---

## Task 6: Document the OneSearch MCP server setup

**Files:**
- Create: `docs/WEB_SEARCH_SETUP.md`
- Test: none (documentation)

- [ ] **Step 1: Write the setup doc**

Create `docs/WEB_SEARCH_SETUP.md`:

```markdown
# Web Search (web_searcher persona)

The `web_searcher` persona finds external knowledge via a **web-search MCP
server**. It has no built-in search; you must configure one MCP server that
exposes a search tool. Recommended: **OneSearch MCP** (backed by the DuckDuckGo
MCP Server and DDGS MCP).

## 1. Add the MCP server to your config

In your MiMo config (`mcpServers`), add an entry. The server `name` you choose
becomes the tool prefix `mcp__<name>__…`:

```jsonc
{
  "mcpServers": [
    {
      "name": "onesearch",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "one-search-mcp"]
    }
  ]
}
```

`web_searcher`'s allowlist includes `mcp__*`, so it will pick up the server's
tools regardless of the exact name you choose.

## 2. (Optional) Restrict what is grantable/usable

`web_searcher` is read-only and cannot write or run shell commands. If you want
to keep its MCP surface minimal, name only search-oriented MCP servers in your
config, or add unwanted tool names to `capabilityGrants.denylistMcpTools`.

## 3. Verify

Start the orchestrator and run a task that needs current external info (e.g.
"summarize the latest API for library X"). The master should emit a P0
`web_searcher` task; its brief shows `mcp__onesearch__…` and `web_fetch` calls.

If no search MCP tool is connected, `web_searcher` reports that search is
unavailable instead of fabricating results.
```

- [ ] **Step 2: Commit**

```bash
git add docs/WEB_SEARCH_SETUP.md
git commit -m "docs: OneSearch MCP setup for the web_searcher persona"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck root + tui**

Run: `npx tsc -p tsconfig.json --noEmit`
Run: `cd tui && npx tsc --noEmit && cd ..`
Expected: both clean.

- [ ] **Step 2: Run the touched test files**

Run: `npx vitest run tests/unit/tool-allowlist-enforcer.test.ts tests/unit/persona-registry.test.ts tests/unit/mimo-pipeline.test.ts tests/unit/worker-loop.test.ts`
Expected: all PASS.

- [ ] **Step 3: Run the full suite and confirm no NEW failures**

Run: `npx vitest run`
Expected: only the pre-existing platform failures (`files`, `hooks-capacity-bridge`, `memory-prelude-builder`, `utils`) — no new failures attributable to this change. If a new failure references `PersonaId` exhaustiveness, add the `web_searcher` branch at that site mirroring `repo_scout`.

- [ ] **Step 4: Final build**

Run: `npm run build`
Expected: success; `dist/personas/prompts/web-searcher.md` exists.

---

## Self-Review (completed during planning)

- **Decision coverage:** OneSearch MCP mechanism → Task 1 (wildcard) + Task 3 (allowlist `mcp__*`) + Task 6 (server setup); perception role → Task 4; persona definition → Tasks 2+3; master awareness → Task 5.
- **Three id lists** (`PersonaId` union, registry `buildPersonas`, `buildValidPersonaIdsBlock`) are each updated (Tasks 2, 3, 3) — the most common omission when adding a persona.
- **Placeholder scan:** every code step shows complete code; Task 2 Step 2 intentionally flags an *expected* transient `tsc` error resolved by Task 3, not a placeholder.
- **Type consistency:** `web_searcher`, `allowlistMatches`, `mcp__*`, `PERCEPTION_PERSONAS`, `buildPersonaPrompt("web_searcher", "web-searcher.md", footer)` are used identically across tasks.
- **Least-privilege note:** `mcp__*` grants web_searcher every connected MCP tool, not just search. It is read-only (no write/exec), which bounds the risk; Task 6 documents narrowing via config/denylist. A tighter, config-scoped prefix (e.g. `mcp__onesearch__*`) is a viable follow-up if multiple unrelated MCP servers are ever connected.
