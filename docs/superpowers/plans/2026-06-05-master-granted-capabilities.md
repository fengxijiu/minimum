# Master-Granted Capabilities (skills + MCP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let master_planner grant a task extra skills and MCP tools — drawn from a governed pool personas lack by default — at W0.5 Refine, enforced per-task at worker launch.

**Architecture:** Grants ride on the `TaskContract` (emitted in `<refine>`, consumed by the worker runtime). A catalog of grantable capabilities (learned skills + connected MCP tools, minus a denylist) is injected into the master's refine prompt. WorkerLoop un-filters granted MCP tool names; the worker executor injects granted skill bodies. A catalog-aware validator rejects unknown/denied grants at refine time.

**Tech Stack:** TypeScript (ESM, NodeNext), Vitest. No new runtime deps.

**Spec:** `docs/superpowers/specs/2026-06-05-master-granted-capabilities-design.md`

---

## File Structure

- **Modify** `src/orchestration/TaskContract.ts` — add `grantedSkills` / `grantedMcpTools` to `TaskContract`.
- **Modify** `src/orchestration/Refiner.ts` — parse the two fields in `<refine>`; copy into the contract.
- **Create** `src/orchestration/CapabilityCatalog.ts` — build + render the grantable catalog; `validateGrants`.
- **Modify** `src/orchestration/ContractValidator.ts` — re-export `validateGrants` (kept catalog-aware, separate from pure `validateContract`).
- **Modify** `src/config/MiMoConfig.ts` — `capabilityGrants` config + default.
- **Modify** `src/orchestration/WorkerLoop.ts` — un-filter granted MCP tools in the per-persona tool filter.
- **Modify** `src/personas/PersonaSkillMap.ts` — add `loadGrantedSkillPrompt`.
- **Modify** `src/orchestration/ClientAdapters.ts` — inject granted skills into the worker prompt; thread the catalog into `refine()`.
- **Modify** `src/orchestration/MiMoPipeline.ts` — carry catalog into refine, validate grants, surface errors.
- **Modify** `src/personas/prompts/master-planner.md` — "Capability Grants (W0.5)" section.
- **Tests:** `tests/unit/refiner.test.ts`, `tests/unit/capability-catalog.test.ts` (new), `tests/unit/worker-loop.test.ts`, `tests/unit/persona-skill-map.test.ts`, `tests/unit/mimo-pipeline.test.ts`.

> **Convention note:** this repo uses NodeNext ESM — every relative import ends in `.js`. Run a single unit file with `npx vitest run tests/unit/<file>.test.ts`.

---

## Task 1: Data model — grant fields on TaskContract

**Files:**
- Modify: `src/orchestration/TaskContract.ts` (after `dependsOn`, ~line 57)
- Modify: `src/orchestration/Refiner.ts:255-280` (contract assembly)
- Test: `tests/unit/refiner.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/refiner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { refineDag } from "../../src/orchestration/Refiner.js";
import type { CoarseDag } from "../../src/orchestration/TaskContract.js";

function minimalDag(): CoarseDag {
  return {
    epicId: "e1",
    phases: [
      { id: "P0", name: "perception", tasks: [
        { id: "T0-1", personaId: "repo_scout", objective: "scan the repo layout please",
          parallelGroup: "perception", dependsOn: [], needsRefine: false },
      ] },
    ],
  } as unknown as CoarseDag;
}

describe("grant fields default to empty", () => {
  it("a contract with no granted entry has empty grant arrays", () => {
    const { contracts } = refineDag(minimalDag(), {
      inputs: { userGoal: "do the thing", artifacts: [], constraints: [] },
      refinement: new Map(),
    });
    const c = contracts.find((x) => x.taskId === "T0-1")!;
    expect(c.grantedSkills).toEqual([]);
    expect(c.grantedMcpTools).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/refiner.test.ts -t "grant fields default"`
Expected: FAIL — `grantedSkills`/`grantedMcpTools` are `undefined`, and/or `TaskContract` has no such property (type error).

- [ ] **Step 3: Add the fields to the type**

In `src/orchestration/TaskContract.ts`, immediately after the `dependsOn: string[];` field:

```ts
	/** Upstream task ids that must complete before this task starts. */
	dependsOn: string[];

	/** Skills the master granted this task on top of the persona's defaults. */
	grantedSkills: string[];
	/** MCP tool names (mcp__server__tool) the master granted this task. */
	grantedMcpTools: string[];
```

- [ ] **Step 4: Populate them in the contract assembly**

In `src/orchestration/Refiner.ts`, inside the `const contract: TaskContract = { ... }` literal (after `dependsOn: task.dependsOn,`):

```ts
		dependsOn: task.dependsOn,
		grantedSkills: entry?.grantedSkills ?? [],
		grantedMcpTools: entry?.grantedMcpTools ?? [],
		abortOnConflict: false,
```

> `entry` is the `RefinementEntry | undefined` already in scope; its fields are added in Task 2. TS will accept `entry?.grantedSkills` only after Task 2 adds them to `RefinementEntry`. **Do Task 2 Step 3 before re-running** — or temporarily use `(entry as any)?.grantedSkills ?? []` and tighten in Task 2. Prefer just proceeding to Task 2.

- [ ] **Step 5: Run test to verify it passes** (after Task 2 Step 3 lands the `RefinementEntry` fields)

Run: `npx vitest run tests/unit/refiner.test.ts -t "grant fields default"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/TaskContract.ts src/orchestration/Refiner.ts tests/unit/refiner.test.ts
git commit -m "feat(orchestration): add grantedSkills/grantedMcpTools to TaskContract"
```

---

## Task 2: Parse grant fields from the `<refine>` block

**Files:**
- Modify: `src/orchestration/Refiner.ts:24-37` (`RefinementEntry`), `:72-131` (`validateEntry`)
- Test: `tests/unit/refiner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { compileRefinement } from "../../src/orchestration/Refiner.js";

describe("compileRefinement parses grants", () => {
  it("reads grantedSkills and grantedMcpTools, defaulting to []", () => {
    const text = `<refine>{"tasks":[
      {"taskId":"T2-1","allowedGlobs":["src/a.ts"],
       "grantedSkills":["pdf-extract"],"grantedMcpTools":["mcp__gh__create_issue"]},
      {"taskId":"T2-2","allowedGlobs":["src/b.ts"]}
    ]}</refine>`;
    const res = compileRefinement(text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries.get("T2-1")!.grantedSkills).toEqual(["pdf-extract"]);
    expect(res.entries.get("T2-1")!.grantedMcpTools).toEqual(["mcp__gh__create_issue"]);
    expect(res.entries.get("T2-2")!.grantedSkills).toEqual([]);
    expect(res.entries.get("T2-2")!.grantedMcpTools).toEqual([]);
  });

  it("rejects a non-string-array grant", () => {
    const text = `<refine>{"tasks":[
      {"taskId":"T2-1","allowedGlobs":["src/a.ts"],"grantedSkills":"pdf"}
    ]}</refine>`;
    const res = compileRefinement(text);
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/refiner.test.ts -t "compileRefinement parses grants"`
Expected: FAIL — entries lack `grantedSkills`/`grantedMcpTools`.

- [ ] **Step 3: Add the fields to `RefinementEntry`**

In `src/orchestration/Refiner.ts`, in the `RefinementEntry` interface (after `constraints?`):

```ts
	constraints?: string[];
	/** Skills the master grants this task (ids from the grantable catalog). */
	grantedSkills?: string[];
	/** MCP tool names the master grants this task. */
	grantedMcpTools?: string[];
```

- [ ] **Step 4: Parse + validate them in `validateEntry`**

In `validateEntry`, after the `contextPack` validation block (~line 113) and before the `return { ok: true, entry: { ... } }`:

```ts
	const grantedSkills = raw.grantedSkills ?? raw.granted_skills ?? [];
	if (!Array.isArray(grantedSkills) || !grantedSkills.every((s) => typeof s === "string"))
		return { ok: false, error: `refine entry ${taskId}: grantedSkills must be string[] or omitted` };

	const grantedMcpTools = raw.grantedMcpTools ?? raw.granted_mcp_tools ?? [];
	if (!Array.isArray(grantedMcpTools) || !grantedMcpTools.every((s) => typeof s === "string"))
		return { ok: false, error: `refine entry ${taskId}: grantedMcpTools must be string[] or omitted` };
```

Then add to the returned `entry` object literal (always set, defaulting to `[]`):

```ts
			...(contextPack !== undefined && { contextPack }),
			grantedSkills: grantedSkills as string[],
			grantedMcpTools: grantedMcpTools as string[],
		},
```

- [ ] **Step 5: Run tests to verify they pass** (Task 1 + Task 2 tests)

Run: `npx vitest run tests/unit/refiner.test.ts`
Expected: PASS (both `grant fields default` and `compileRefinement parses grants`)

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/Refiner.ts tests/unit/refiner.test.ts
git commit -m "feat(orchestration): parse grantedSkills/grantedMcpTools from <refine>"
```

---

## Task 3: Capability catalog builder + renderer

**Files:**
- Create: `src/orchestration/CapabilityCatalog.ts`
- Test: `tests/unit/capability-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/capability-catalog.test.ts`:

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGrantableCatalog, renderGrantableCatalog } from "../../src/orchestration/CapabilityCatalog.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-cat-"));
  const learned = path.join(dir, ".minimum", "skills", "learned", "pdf-extract");
  fs.mkdirSync(learned, { recursive: true });
  fs.writeFileSync(path.join(learned, "SKILL.md"),
    "---\nid: pdf-extract\n---\n## When to Use\n- Extract text from PDFs\n");
  const denied = path.join(dir, ".minimum", "skills", "learned", "secret-skill");
  fs.mkdirSync(denied, { recursive: true });
  fs.writeFileSync(path.join(denied, "SKILL.md"), "---\n---\n## When to Use\n- secret\n");
  fs.writeFileSync(path.join(dir, ".minimum", "skills", "index.json"),
    JSON.stringify({ skills: { "pdf-extract": { triggers: ["pdf"] } } }));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("buildGrantableCatalog", () => {
  it("lists learned skills and MCP tools, minus denylists", async () => {
    const cat = await buildGrantableCatalog({
      projectRoot: dir,
      mcpTools: [
        { name: "mcp__gh__create_issue", description: "open an issue" },
        { name: "mcp__gh__delete_repo", description: "danger" },
      ],
      denylistSkills: ["secret-skill"],
      denylistMcpTools: ["mcp__gh__delete_repo"],
    });
    expect(cat.skills.map((s) => s.id)).toEqual(["pdf-extract"]);
    expect(cat.skills[0]!.triggers).toEqual(["pdf"]);
    expect(cat.mcpTools.map((t) => t.name)).toEqual(["mcp__gh__create_issue"]);
  });

  it("renders a non-empty section and an empty marker", async () => {
    const cat = await buildGrantableCatalog({ projectRoot: dir, mcpTools: [], denylistSkills: [], denylistMcpTools: [] });
    expect(renderGrantableCatalog(cat)).toContain("pdf-extract");
    const empty = renderGrantableCatalog({ skills: [], mcpTools: [] });
    expect(empty).toContain("(none)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/capability-catalog.test.ts`
Expected: FAIL — module `CapabilityCatalog.ts` does not exist.

- [ ] **Step 3: Implement the catalog module**

Create `src/orchestration/CapabilityCatalog.ts`:

```ts
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface GrantableSkill {
  id: string;
  brief: string;
  triggers: string[];
}
export interface GrantableMcpTool {
  name: string;
  description: string;
}
export interface GrantableCatalog {
  skills: GrantableSkill[];
  mcpTools: GrantableMcpTool[];
}

export interface BuildCatalogInput {
  projectRoot: string;
  /** Connected MCP tools as {name: "mcp__server__tool", description}. */
  mcpTools: GrantableMcpTool[];
  denylistSkills: string[];
  denylistMcpTools: string[];
}

export async function buildGrantableCatalog(input: BuildCatalogInput): Promise<GrantableCatalog> {
  const deniedSkills = new Set(input.denylistSkills);
  const deniedTools = new Set(input.denylistMcpTools);

  const skills: GrantableSkill[] = [];
  const learnedDir = path.join(input.projectRoot, ".minimum", "skills", "learned");
  const index = await readIndex(input.projectRoot);
  let ids: string[] = [];
  try {
    ids = (await fs.readdir(learnedDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    ids = [];
  }
  for (const id of ids.sort()) {
    if (deniedSkills.has(id)) continue;
    skills.push({ id, brief: await readBrief(learnedDir, id), triggers: index[id]?.triggers ?? [] });
  }

  const mcpTools = input.mcpTools
    .filter((t) => !deniedTools.has(t.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { skills, mcpTools };
}

export function renderGrantableCatalog(catalog: GrantableCatalog): string {
  const skillLines = catalog.skills.length
    ? catalog.skills.map((s) => `- ${s.id}: ${s.brief}${s.triggers.length ? `  _(triggers: ${s.triggers.slice(0, 3).join(", ")})_` : ""}`)
    : ["(none)"];
  const toolLines = catalog.mcpTools.length
    ? catalog.mcpTools.map((t) => `- ${t.name}: ${t.description}`)
    : ["(none)"];
  return [
    "# Grantable Capabilities (skills + MCP)",
    "",
    "Grant a task the MINIMUM extra capability it needs via grantedSkills / grantedMcpTools. Default to none.",
    "",
    "## Grantable Skills",
    ...skillLines,
    "",
    "## Grantable MCP Tools",
    ...toolLines,
  ].join("\n");
}

async function readBrief(learnedDir: string, id: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(learnedDir, id, "SKILL.md"), "utf-8");
    const body = raw.replace(/^---[\s\S]*?\n---\s*/, "").trim();
    const firstBullet = body.split(/\r?\n/).find((l) => l.trim().startsWith("-"));
    if (firstBullet) return firstBullet.replace(/^[-*]\s*/, "").trim().slice(0, 80);
    const firstLine = body.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    return (firstLine ?? id).trim().slice(0, 80);
  } catch {
    return id;
  }
}

async function readIndex(projectRoot: string): Promise<Record<string, { triggers?: string[] }>> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, ".minimum", "skills", "index.json"), "utf-8");
    const parsed = JSON.parse(raw) as { skills?: Record<string, { triggers?: string[] }> };
    return parsed.skills ?? {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/capability-catalog.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/CapabilityCatalog.ts tests/unit/capability-catalog.test.ts
git commit -m "feat(orchestration): grantable capability catalog builder + renderer"
```

---

## Task 4: Validate grants against the catalog

**Files:**
- Modify: `src/orchestration/CapabilityCatalog.ts` (add `validateGrants`)
- Test: `tests/unit/capability-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/capability-catalog.test.ts`:

```ts
import { validateGrants } from "../../src/orchestration/CapabilityCatalog.js";
import type { TaskContract } from "../../src/orchestration/TaskContract.js";

function contractWith(grantedSkills: string[], grantedMcpTools: string[]): TaskContract {
  return { taskId: "T2-1", grantedSkills, grantedMcpTools } as unknown as TaskContract;
}

describe("validateGrants", () => {
  const catalog = { skills: [{ id: "pdf-extract", brief: "", triggers: [] }],
                    mcpTools: [{ name: "mcp__gh__create_issue", description: "" }] };

  it("passes when every grant is in the catalog", () => {
    expect(validateGrants(contractWith(["pdf-extract"], ["mcp__gh__create_issue"]), catalog)).toEqual([]);
  });

  it("rejects an unknown skill and an unknown tool", () => {
    const errs = validateGrants(contractWith(["ghost-skill"], ["mcp__gh__nope"]), catalog);
    expect(errs.some((e) => e.includes("ghost-skill"))).toBe(true);
    expect(errs.some((e) => e.includes("mcp__gh__nope"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/capability-catalog.test.ts -t "validateGrants"`
Expected: FAIL — `validateGrants` not exported.

- [ ] **Step 3: Implement `validateGrants`**

Append to `src/orchestration/CapabilityCatalog.ts`:

```ts
import type { TaskContract } from "./TaskContract.js";

/** Errors for grants that reference capabilities absent from the catalog. */
export function validateGrants(contract: TaskContract, catalog: GrantableCatalog): string[] {
  const errors: string[] = [];
  const skillIds = new Set(catalog.skills.map((s) => s.id));
  const toolNames = new Set(catalog.mcpTools.map((t) => t.name));
  for (const id of contract.grantedSkills ?? []) {
    if (!skillIds.has(id))
      errors.push(`task ${contract.taskId}: grantedSkill "${id}" is not in the grantable catalog (unknown or denied)`);
  }
  for (const name of contract.grantedMcpTools ?? []) {
    if (!toolNames.has(name))
      errors.push(`task ${contract.taskId}: grantedMcpTool "${name}" is not in the grantable catalog (unknown or denied)`);
  }
  return errors;
}
```

> Move the `import type { TaskContract }` to the top of the file with the other imports — shown inline here only for locality.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/capability-catalog.test.ts`
Expected: PASS (all catalog tests)

- [ ] **Step 5: Re-export from ContractValidator for discoverability**

In `src/orchestration/ContractValidator.ts`, at the end of the file:

```ts
export { validateGrants } from "./CapabilityCatalog.js";
```

- [ ] **Step 6: Commit**

```bash
git add src/orchestration/CapabilityCatalog.ts src/orchestration/ContractValidator.ts tests/unit/capability-catalog.test.ts
git commit -m "feat(orchestration): validateGrants against the grantable catalog"
```

---

## Task 5: Config — capabilityGrants denylist + kill switch

**Files:**
- Modify: `src/config/MiMoConfig.ts:139-142` (interface) and `DEFAULT_MIMO_CONFIG` (~line 145)
- Test: none (pure type + default; covered by Task 9 integration)

- [ ] **Step 1: Add the config interface field**

In `src/config/MiMoConfig.ts`, after the `mcpServers?: McpServerConfig[];` field in `MiMoConfig`:

```ts
	mcpServers?: McpServerConfig[];
	/** Master-granted per-task capabilities (skills + MCP). */
	capabilityGrants?: {
		/** Master kill-switch; when false no grants are offered or honored. Default true. */
		enabled?: boolean;
		/** Skill ids that may never be granted. */
		denylistSkills?: string[];
		/** MCP tool names (mcp__server__tool) that may never be granted. */
		denylistMcpTools?: string[];
	};
```

- [ ] **Step 2: Add the default**

`DEFAULT_MIMO_CONFIG` is `Required<MiMoConfig>`, so add a default value. After the `mcpServers: []` (or equivalent) entry in `DEFAULT_MIMO_CONFIG`:

```ts
	capabilityGrants: {
		enabled: true,
		denylistSkills: [],
		denylistMcpTools: [],
	},
```

> If `mcpServers` is not already present in `DEFAULT_MIMO_CONFIG`, add `mcpServers: [],` too — `Required<MiMoConfig>` demands every key. Verify by running the typecheck in Step 3.

- [ ] **Step 3: Verify the project still typechecks**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add src/config/MiMoConfig.ts
git commit -m "feat(config): capabilityGrants denylist + kill switch"
```

---

## Task 6: Enforcement — un-filter granted MCP tools in WorkerLoop

**Files:**
- Modify: `src/orchestration/WorkerLoop.ts:151-154`
- Test: `tests/unit/worker-loop.test.ts`

> WorkerLoop already receives the full contract via `WorkerRunInput.contract`, so no new input field is needed. The contract's grants were already validated against the denylist at refine time (Task 8); WorkerLoop still honors `persona.toolDenylist` as the last line of defense.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/worker-loop.test.ts` (follow the file's existing harness for building a `WorkerLoop` with a fake `IToolHost` + scripted client; mirror an existing test's setup). The behavioral assertions:

```ts
it("exposes a granted MCP tool that the persona allowlist lacks", async () => {
  // host advertises: read_file (repo_scout-allowed) + mcp__gh__create_issue (not in any allowlist)
  // contract.grantedMcpTools = ["mcp__gh__create_issue"]
  // persona = repo_scout
  const toolNames = await runAndCaptureOfferedToolNames({
    hostTools: ["read_file", "mcp__gh__create_issue"],
    persona: "repo_scout",
    grantedMcpTools: ["mcp__gh__create_issue"],
  });
  expect(toolNames).toContain("read_file");
  expect(toolNames).toContain("mcp__gh__create_issue");
});

it("does not expose an ungranted MCP tool", async () => {
  const toolNames = await runAndCaptureOfferedToolNames({
    hostTools: ["read_file", "mcp__gh__create_issue"],
    persona: "repo_scout",
    grantedMcpTools: [],
  });
  expect(toolNames).not.toContain("mcp__gh__create_issue");
});

it("never exposes a granted tool that is in the persona denylist", async () => {
  // exec_shell is in repo_scout's denylist; granting must not override a denylist
  const toolNames = await runAndCaptureOfferedToolNames({
    hostTools: ["read_file", "exec_shell"],
    persona: "repo_scout",
    grantedMcpTools: ["exec_shell"],
  });
  expect(toolNames).not.toContain("exec_shell");
});
```

> `runAndCaptureOfferedToolNames` is a small local helper: construct the `WorkerLoop` with a fake host whose `getDefinitions()` returns `hostTools` as `{name, description:"", parameters:{type:"object",properties:{}}}`, a scripted client that emits one final assistant message (no tool calls) so the loop exits after one turn, then capture `personaTools` — either by spying on the client's `streamChat({tools})` arg or by exporting a thin `selectPersonaTools(allTools, persona, grantedMcpTools)` pure function (preferred — see Step 3).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/worker-loop.test.ts -t "granted MCP"`
Expected: FAIL — granted tool not exposed; denylisted tool not yet specially handled.

- [ ] **Step 3: Extract a pure selector and use the contract grants**

In `src/orchestration/WorkerLoop.ts`, add an exported pure helper near the top (after imports):

```ts
import { checkTool } from "../tools/policy/ToolAllowlistEnforcer.js";
import type { ToolDefinition } from "../types/common.js";
import type { Persona } from "../personas/Persona.js";

/** Tools a persona may invoke: its allowlist, plus granted MCP tools, minus its denylist. */
export function selectPersonaTools(
  allTools: ToolDefinition[],
  persona: Persona,
  grantedMcpTools: string[],
): ToolDefinition[] {
  const granted = new Set(grantedMcpTools);
  return allTools.filter((t) =>
    checkTool(t.name, persona).ok ||
    (granted.has(t.name) && !persona.toolDenylist.includes(t.name)));
}
```

Then replace the filter at lines 151-154:

```ts
		const allTools = this.tools.getDefinitions();
		const personaTools = selectPersonaTools(
			allTools,
			input.persona,
			input.contract.grantedMcpTools ?? [],
		);
```

> If `checkTool` is already imported in WorkerLoop, do not duplicate the import. Have the new unit test call `selectPersonaTools` directly — that is the cleanest way to assert tool selection without driving a full loop.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/worker-loop.test.ts`
Expected: PASS (whole file)

- [ ] **Step 5: Commit**

```bash
git add src/orchestration/WorkerLoop.ts tests/unit/worker-loop.test.ts
git commit -m "feat(orchestration): un-filter granted MCP tools per task in WorkerLoop"
```

---

## Task 7: Enforcement — inject granted skill bodies into the worker prompt

**Files:**
- Modify: `src/personas/PersonaSkillMap.ts` (add `loadGrantedSkillPrompt`)
- Modify: `src/orchestration/ClientAdapters.ts:291-299`
- Test: `tests/unit/persona-skill-map.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/persona-skill-map.test.ts` (mirror existing fs-temp setup in that file):

```ts
import { loadGrantedSkillPrompt } from "../../src/personas/PersonaSkillMap.js";

it("loads granted skill bodies regardless of the persona-skill-map", async () => {
  // dir/.minimum/skills/learned/pdf-extract/SKILL.md exists; persona-skill-map.json does NOT list it
  const out = await loadGrantedSkillPrompt(dir, ["pdf-extract"]);
  expect(out).toContain("pdf-extract");        // body or header present
  expect(out).toContain("Granted Skills");     // neutral section header
});

it("returns empty string when nothing is granted", async () => {
  expect(await loadGrantedSkillPrompt(dir, [])).toBe("");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/persona-skill-map.test.ts -t "granted skill"`
Expected: FAIL — `loadGrantedSkillPrompt` not exported.

- [ ] **Step 3: Implement `loadGrantedSkillPrompt`**

In `src/personas/PersonaSkillMap.ts`, add (it can reuse the existing private `readLearnedSkillBody`):

```ts
/**
 * Full-body prompt for master-granted skills, independent of persona-skill-map.
 * Neutral framing — the worker sees the capability, not the grant mechanism.
 */
export async function loadGrantedSkillPrompt(projectRoot: string, skillIds: string[]): Promise<string> {
	if (!skillIds.length) return "";
	const bodies: string[] = [];
	for (const id of skillIds) {
		const body = await readLearnedSkillBody(projectRoot, id);
		if (body) bodies.push(`<!-- granted-skill:${id} -->\n${body}`);
	}
	return bodies.length ? `# Granted Skills\n\n${bodies.join("\n\n")}` : "";
}
```

- [ ] **Step 4: Wire it into the worker system prompt**

In `src/orchestration/ClientAdapters.ts`, update the system-prompt assembly (lines 291-299). Add the import at the top alongside the existing `loadProjectSkillPrompt` import:

```ts
import { loadProjectSkillPrompt, loadGrantedSkillPrompt } from "../personas/PersonaSkillMap.js";
```

Then:

```ts
			const projectSkills = opts.projectRoot
				? await loadProjectSkillPrompt({
					projectRoot: opts.projectRoot,
					personaId: contract.personaId,
					stage: contract.phase,
					objective: contract.objective,
				})
				: "";
			const grantedSkills = opts.projectRoot
				? await loadGrantedSkillPrompt(opts.projectRoot, contract.grantedSkills ?? [])
				: "";
			const systemPrompt = [persona.systemPrompt, projectSkills, grantedSkills]
				.filter((s) => s && s.trim())
				.join("\n\n");
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/persona-skill-map.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/personas/PersonaSkillMap.ts src/orchestration/ClientAdapters.ts tests/unit/persona-skill-map.test.ts
git commit -m "feat(orchestration): inject master-granted skill bodies into worker prompt"
```

---

## Task 8: Wire the catalog through refine + validate grants in the pipeline

**Files:**
- Modify: `src/orchestration/MiMoPipeline.ts` (`PlannerBridge.refine` signature ~line 92; `PipelineOptions` ~line 112; refine call ~line 461; grant validation after `refineDag` ~line 497)
- Modify: `src/orchestration/ClientAdapters.ts` (`refine` impl ~line 113)
- Test: `tests/unit/mimo-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/unit/mimo-pipeline.test.ts`, extend the stub planner so refine emits a grant, and assert the resulting contract carries it. Use the existing `stubPlanner` + a full run that reaches W2/3. Add:

```ts
it("carries master grants from <refine> onto the launched contract", async () => {
  const events: PipelineEvent[] = [];
  // stubPlanner.refine emits grantedMcpTools for the impl task
  const planner = stubPlanner({
    refine: async () =>
      `<refine>{"tasks":[{"taskId":"T2-1","allowedGlobs":["src/upload.ts"],"acceptance":["returns 201"],"blockedCondition":"blocked if T0-1.file_list is unavailable or incomplete","grantedSkills":[],"grantedMcpTools":["mcp__gh__create_issue"]}]}</refine>`,
  });
  const seen: string[] = [];
  const executor: WorkerExecutor = {
    async run(contract) { seen.push(...contract.grantedMcpTools); return OK; },
  };
  const result = await runPipeline("build an upload endpoint", {
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "mimo-grant-")),
    planner, executor, onEvent: (e) => events.push(e), choiceGate: continueGate(),
    grantableCatalog: { skills: [], mcpTools: [{ name: "mcp__gh__create_issue", description: "" }] },
  });
  expect(result.ok).toBe(true);
  expect(seen).toContain("mcp__gh__create_issue");
});

it("blocks the run when a grant is not in the catalog", async () => {
  const planner = stubPlanner({
    refine: async () =>
      `<refine>{"tasks":[{"taskId":"T2-1","allowedGlobs":["src/upload.ts"],"acceptance":["x"],"blockedCondition":"blocked if T0-1.file_list is unavailable or incomplete","grantedMcpTools":["mcp__gh__nope"]}]}</refine>`,
  });
  const events: PipelineEvent[] = [];
  const result = await runPipeline("build an upload endpoint", {
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "mimo-grant2-")),
    planner, executor: okExecutor(), onEvent: (e) => events.push(e), choiceGate: continueGate(),
    grantableCatalog: { skills: [], mcpTools: [] },
  });
  // grant validation surfaces as a refine/known-issue error path
  expect(events.some((e) => e.type === "pipeline_error" || e.type === "human_confirmation_required")).toBe(true);
});
```

> Confirm the first test's `grantableCatalog` field name matches the `PipelineOptions` field added in Step 2. Match the second test's expected event to however refine errors already surface in this file (grep existing refine-error tests and mirror their assertion).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/mimo-pipeline.test.ts -t "master grants"`
Expected: FAIL — `grantableCatalog` is not a `PipelineOptions` field; grant not threaded.

- [ ] **Step 3: Extend `PlannerBridge.refine` and `PipelineOptions`**

In `src/orchestration/MiMoPipeline.ts`:

Add the import:

```ts
import type { GrantableCatalog } from "./CapabilityCatalog.js";
import { validateGrants } from "./CapabilityCatalog.js";
```

Change the `refine` signature in the `PlannerBridge` interface:

```ts
	/** W0.5: returns master output containing a <refine> block. */
	refine(
		dag: CoarseDag,
		perception: TaskResult[],
		memoryPrefix: string,
		catalog?: GrantableCatalog,
		feedback?: string,
	): Promise<string>;
```

Add to `PipelineOptions`:

```ts
	choiceGate?: ConfirmationGate;
	/** Catalog of grantable skills + MCP tools, injected into W0.5 refine. */
	grantableCatalog?: GrantableCatalog;
```

- [ ] **Step 4: Pass the catalog at the refine call site and validate grants**

In `runDagPass`, update the refine call (currently `opts.planner.refine(dag, allResults, memoryText, refineFeedback)`):

```ts
			const refineText = await opts.planner.refine(dag, allResults, memoryText, opts.opts.grantableCatalog, refineFeedback);
```

> `runDagPass` receives `opts: DagPassOptions`, whose `.opts` is the `PipelineOptions`. Use the correct accessor for this file — grep the function for how it already reads `opts.opts.*` vs `opts.*` and match it.

After `const refined = refineDag(dag, { ... })` produces `refined.contracts`, add grant validation when a catalog is present:

```ts
			if (opts.opts.grantableCatalog) {
				for (const c of refined.contracts) {
					const grantErrors = validateGrants(c, opts.opts.grantableCatalog);
					if (grantErrors.length) {
						refineErrors.push({ taskId: c.taskId, errors: grantErrors });
					}
				}
			}
```

> Match `refineErrors`'s actual shape in this file (it is `ReturnType<typeof refineDag>["errors"]`, i.e. `{ taskId, errors }[]`). Grant errors then flow through the existing refine-error handling that already triggers retry / human-confirmation. Verify by reading how `refineErrors` is consumed downstream and mirror it.

- [ ] **Step 5: Render the catalog in the real planner's refine prompt**

In `src/orchestration/ClientAdapters.ts`, update the `refine` implementation signature and body to accept `catalog` and inject it. Add the import:

```ts
import { renderGrantableCatalog } from "./CapabilityCatalog.js";
import type { GrantableCatalog } from "./CapabilityCatalog.js";
```

Change the impl:

```ts
		refine: async (dag: CoarseDag, perception: TaskResult[], memoryPrefix: string, catalog?: GrantableCatalog, feedback?: string) => {
			// ...existing requiredRefinementTaskIds + userContent...
			if (catalog) {
				userContent.push(renderGrantableCatalog(catalog));
			}
			// ...existing feedback push + collectText...
		},
```

> Keep the existing `userContent` assembly; only add the catalog push before the `feedback` push. The `feedback` parameter moved from 4th to 5th positional — update any other direct callers (there are none outside the pipeline; stub planners ignore args).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/unit/mimo-pipeline.test.ts`
Expected: PASS (including the two new tests and all pre-existing ones)

- [ ] **Step 7: Typecheck the whole project**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean. (Fixes any stub planner in tests still using the old `refine` arity — args are ignored so this should already pass.)

- [ ] **Step 8: Commit**

```bash
git add src/orchestration/MiMoPipeline.ts src/orchestration/ClientAdapters.ts tests/unit/mimo-pipeline.test.ts
git commit -m "feat(orchestration): thread grantable catalog into refine + validate grants"
```

---

## Task 9: Build + inject the catalog from the bridge; master prompt guidance

**Files:**
- Modify: `src/bridge/PipelineBridge.ts` (build catalog from MCP host + config, pass into `runPipeline`)
- Modify: `src/personas/prompts/master-planner.md`
- Test: `tests/unit/pipeline-bridge.test.ts`

- [ ] **Step 1: Verify the worker host carries MCP adapters (spec §3 open question)**

Trace how orchestrate mode constructs the `IToolHost` passed as `PipelineBridgeOptions.tools` and whether `connectMcpServers` registered MCP adapters into that same registry.

Run: `npx vitest run tests/unit/mcp.test.ts` and read `src/mcp/connectMcpServers.ts` + the orchestrate entry that builds `PipelineBridge`.
Expected outcome: a one-line note in this task's commit message stating whether the worker host already contains `mcp__*` definitions. If it does NOT, add a sub-step to register the MCP adapters into the worker host before continuing — granting names is inert otherwise.

- [ ] **Step 2: Write the failing test**

In `tests/unit/pipeline-bridge.test.ts`, assert that when the bridge is constructed with a tool host advertising an `mcp__*` tool and `capabilityGrants` config, `runPipeline` is invoked with a `grantableCatalog` containing that tool. The cleanest seam: export a small `buildCatalogForBridge(opts)` from `PipelineBridge.ts` and unit-test it directly:

```ts
import { buildCatalogForBridge } from "../../src/bridge/PipelineBridge.js";

it("builds a grantable catalog from host MCP tools minus denylist", async () => {
  const host = { getDefinitions: () => [
    { name: "read_file", description: "", parameters: { type: "object", properties: {} } },
    { name: "mcp__gh__create_issue", description: "open issue", parameters: { type: "object", properties: {} } },
    { name: "mcp__gh__delete_repo", description: "danger", parameters: { type: "object", properties: {} } },
  ] };
  const cat = await buildCatalogForBridge({
    projectRoot: dir, tools: host as any,
    capabilityGrants: { enabled: true, denylistSkills: [], denylistMcpTools: ["mcp__gh__delete_repo"] },
  });
  expect(cat!.mcpTools.map((t) => t.name)).toEqual(["mcp__gh__create_issue"]);
});

it("returns undefined when grants are disabled", async () => {
  const cat = await buildCatalogForBridge({ projectRoot: dir, tools: undefined,
    capabilityGrants: { enabled: false } });
  expect(cat).toBeUndefined();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/pipeline-bridge.test.ts -t "grantable catalog"`
Expected: FAIL — `buildCatalogForBridge` not exported.

- [ ] **Step 4: Implement `buildCatalogForBridge` and pass the catalog into `runPipeline`**

In `src/bridge/PipelineBridge.ts`:

```ts
import { buildGrantableCatalog, type GrantableCatalog } from "../orchestration/CapabilityCatalog.js";

export async function buildCatalogForBridge(opts: {
  projectRoot: string;
  tools?: IToolHost;
  capabilityGrants?: { enabled?: boolean; denylistSkills?: string[]; denylistMcpTools?: string[] };
}): Promise<GrantableCatalog | undefined> {
  if (opts.capabilityGrants?.enabled === false) return undefined;
  const mcpTools = (opts.tools?.getDefinitions() ?? [])
    .filter((t) => t.name.startsWith("mcp__"))
    .map((t) => ({ name: t.name, description: t.description ?? "" }));
  return buildGrantableCatalog({
    projectRoot: opts.projectRoot,
    mcpTools,
    denylistSkills: opts.capabilityGrants?.denylistSkills ?? [],
    denylistMcpTools: opts.capabilityGrants?.denylistMcpTools ?? [],
  });
}
```

Then, in the bridge's `send()` path where it calls `runPipeline(...)`, build the catalog once and pass it:

```ts
const grantableCatalog = await buildCatalogForBridge({
  projectRoot: this.opts.projectRoot,
  tools: this.opts.tools,
  capabilityGrants: this.opts.capabilityGrants,
});
// ...add to the runPipeline options object:
//   ...(grantableCatalog && { grantableCatalog }),
```

Add `capabilityGrants?` to `PipelineBridgeOptions` (mirroring the `MiMoConfig` sub-shape) so whoever constructs the bridge forwards `config.capabilityGrants`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/pipeline-bridge.test.ts`
Expected: PASS (whole file)

- [ ] **Step 6: Add master prompt guidance**

In `src/personas/prompts/master-planner.md`, add a section after "## Refine Output (W0.5)":

```markdown
## Capability Grants (W0.5)

You may grant a task extra capabilities it does not have by default, chosen from
the "# Grantable Capabilities" catalog provided in your W0.5 input. Emit them per
task in `<refine>`:

```
{ "taskId": "T2-1", "allowedGlobs": ["..."],
  "grantedSkills": ["pdf-extract"],
  "grantedMcpTools": ["mcp__github__create_issue"] }
```

Rules:

- Grant the MINIMUM extra capability a task needs. Default to none — most tasks
  need nothing extra.
- Only grant ids/names that appear verbatim in the catalog. A grant outside the
  catalog blocks the task.
- Never grant a capability the persona already has by default.
- Prefer `grantedSkills` for know-how/guidance; use `grantedMcpTools` only when
  the task genuinely needs that external integration.
```

- [ ] **Step 7: Build so the prompt reaches dist, then run the full suite**

Run: `npm run build`
Run: `npx vitest run tests/unit/refiner.test.ts tests/unit/capability-catalog.test.ts tests/unit/worker-loop.test.ts tests/unit/persona-skill-map.test.ts tests/unit/mimo-pipeline.test.ts tests/unit/pipeline-bridge.test.ts`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/bridge/PipelineBridge.ts src/personas/prompts/master-planner.md tests/unit/pipeline-bridge.test.ts
git commit -m "feat(orchestration): build grantable catalog in bridge + master grant prompt"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** §1 data model → T1/T2; §2 catalog → T3 + T9; §3 tools → T6; §4 skills → T7; §5 safety/config → T5 + T4 (validation) + T8 (pipeline gate); §6 master prompt → T9. Data flow (W0.5 grant → contract → worker) covered by T8 + integration tests.
- **Placeholder scan:** no TBD/TODO; every code step shows the code. Two steps (T6 Step 1 harness, T8 Step 4 accessor) explicitly say "mirror the existing pattern" rather than inventing — acceptable because they depend on local conventions the executor can read directly.
- **Type consistency:** `GrantableCatalog`, `buildGrantableCatalog`, `renderGrantableCatalog`, `validateGrants`, `selectPersonaTools`, `loadGrantedSkillPrompt`, `buildCatalogForBridge`, and the `grantedSkills`/`grantedMcpTools` field names are used identically across tasks.
- **Open risk (spec §3):** T9 Step 1 verifies the worker host carries MCP adapters before relying on grant un-filtering; if not, it adds the wiring sub-step.
