# Master-Granted Capabilities (skills + MCP) — Design

**Date:** 2026-06-05
**Status:** Approved design, pending implementation plan

## Problem

A worker persona's capabilities are fixed and static:

- **Tools** come only from `persona.toolAllowlist`. WorkerLoop filters the host's
  tool catalog with `checkTool(name, persona)` ([WorkerLoop.ts:151](../../../src/orchestration/WorkerLoop.ts)).
  MCP tools (`mcp__server__tool`) are registered into the tool registry by
  `connectMcpServers`, but no persona allowlist contains their names, so workers
  never see them.
- **Skills** are routed per-persona by `.minimum/skills/persona-skill-map.json`
  via `loadProjectSkillPrompt` ([PersonaSkillMap.ts](../../../src/personas/PersonaSkillMap.ts)) —
  a static map the master cannot influence per task.

The master_planner cannot tailor a task's capabilities. It cannot, for one task,
hand a persona an extra skill or a specific MCP tool that the persona does not
normally carry.

## Goal

Let the master_planner, during planning, **grant** a task additional skills and
MCP tools drawn from a pool that personas do **not** have by default ("invisible"
to the persona). The granted capabilities form a least-privilege, per-task
capability injection.

### Decisions (from brainstorming)

1. **Grant model — both:** there is a pool of skills/MCP personas lack by default;
   the master grants per task on demand; and the worker perceives only the
   injected capability itself, never the grant mechanism or that it was "special".
2. **Stage — W0.5 Refine:** grants are decided while finalizing contracts, when
   perception evidence (repo_scout reports, etc.) is available.
3. **Pool boundary — governed pool + denylist:** by default all learned skills +
   all connected MCP tools are grantable, minus a configured denylist for
   dangerous/sensitive entries. The master sees a catalog of what it may grant.

## Non-Goals

- No new UI surface for managing grants (config + prompt only).
- No change to how the **top-level** agent gets tools/skills — workers only.
- No dynamic re-granting mid-task; grants are fixed at contract time.
- No automatic skill *learning*; the pool is the existing learned-skills set.

## Architecture (Approach A — contract-carried grants)

Grants ride on the `TaskContract`, the same object that already carries
`allowedGlobs`, `acceptance`, etc. The master emits them in `<refine>`; the
worker runtime consumes them. Two alternatives were rejected: a separate grant
ledger/service (indirection, lifecycle-sync), and per-run mutation of
`persona-skill-map.json` (global mutable state, racy under parallel waves).

### 1. Data model

`TaskContract` (`src/orchestration/TaskContract.ts`) gains:

```ts
/** Skill ids the master granted this task on top of the persona's defaults. */
grantedSkills: string[];      // default []
/** MCP tool names (mcp__server__tool) granted to this task. */
grantedMcpTools: string[];    // default []
```

The coarse `<refine>` task entry gains two optional fields with the same names.
`refineDag` / `Refiner` populates the contract fields (defaulting to `[]`).

### 2. Grantable catalog (master side, W0.5)

New module `src/orchestration/CapabilityCatalog.ts`:

```ts
interface GrantableCatalog {
  skills: { id: string; brief: string; triggers: string[] }[];
  mcpTools: { name: string; description: string }[];
}
function buildGrantableCatalog(input: {
  projectRoot: string;
  mcpManager?: McpManager;
  denylistSkills: string[];
  denylistMcpTools: string[];
}): Promise<GrantableCatalog>;
```

- Skills: enumerate `.minimum/skills/learned/*` (reuse the readers in
  `PersonaSkillMap.ts`) + `index.json` for triggers; drop denylisted ids.
- MCP tools: `mcpManager.getAllTools()` mapped to `mcp__server__tool` names; drop
  denylisted names.

`ClientAdapters.refine()` injects a rendered catalog section into the master's
W0.5 user message ("# Grantable Capabilities (skills + MCP)…"). The
`PlannerBridge.refine` signature gains the catalog (or the `McpManager` +
denylists needed to build it) so the pure pipeline stays testable.

### 3. Enforcement — tools

`WorkerRunInput` gains `grantedMcpTools: string[]` (threaded from
`contract.grantedMcpTools` through `createWorkerExecutor` → `WorkerLoop`).

WorkerLoop's filter ([WorkerLoop.ts:152](../../../src/orchestration/WorkerLoop.ts)) becomes:

```ts
const personaTools = allTools.filter((t) =>
  checkTool(t.name, persona).ok ||
  (grantedMcpTools.includes(t.name) &&
   !persona.toolDenylist.includes(t.name) &&
   !globalGrantDenylist.includes(t.name)));
```

Granted MCP tools still flow through the existing approval gate and path policy —
granting visibility does not bypass approval. A granted name whose definition is
absent from the host is a no-op (logged), not a crash.

**Verification task:** confirm the worker's `IToolHost` is the same registry that
`connectMcpServers` registered MCP adapters into. If orchestrate mode passes a
different host, wire the MCP adapters into the worker host.

### 4. Enforcement — skills

New function in `PersonaSkillMap.ts` (or a sibling):

```ts
function loadGrantedSkillPrompt(projectRoot: string, skillIds: string[]): Promise<string>;
```

Loads the **full body** of each granted learned skill (independent of
`persona-skill-map.json`, because these are the invisible pool). The worker
system prompt is assembled as:

```
persona.systemPrompt
+ loadProjectSkillPrompt(...)      // existing routed skills
+ loadGrantedSkillPrompt(...)      // NEW: master-granted skills
```

Rendered with neutral framing (no "granted by master" wording) so the worker sees
only the capability, per decision 1.

### 5. Safety / config

`MiMoConfig` (`src/config/MiMoConfig.ts`) gains:

```ts
capabilityGrants?: {
  enabled?: boolean;            // master kill-switch, default true
  denylistSkills?: string[];    // never grantable
  denylistMcpTools?: string[];  // never grantable (e.g. exec/write-heavy MCP)
};
```

`ContractValidator` rejects a contract whose `grantedSkills` / `grantedMcpTools`
reference ids not present in the catalog or present in a denylist — a
hallucinated or forbidden grant fails the contract (surfaced as
`contract_invalid`) instead of silently no-op'ing.

### 6. Master prompt

`master-planner.md` gains a "Capability Grants (W0.5)" section: grant the
**minimum** extra capabilities a task needs; default to none; never grant a
capability already in the persona's defaults; prefer skills for guidance and MCP
tools only when the task genuinely needs that integration.

## Data flow

```
W0.5 refine:
  buildGrantableCatalog(projectRoot, mcpManager, denylists)
    -> inject catalog into master refine prompt
    -> master emits <refine>.tasks[].{grantedSkills, grantedMcpTools}
  Refiner -> TaskContract.{grantedSkills, grantedMcpTools}
  ContractValidator -> reject unknown/denied grants

W2/3 task run:
  TaskRunner -> createWorkerExecutor(contract.grantedMcpTools)
  WorkerLoop:
    tools  = personaAllowlist ∪ grantedMcpTools (− denylists)
    prompt = persona + routedSkills + grantedSkills
  approval gate + path policy unchanged
```

## Testing strategy

- **Catalog builder:** denylist removes skills/MCP; missing MCP manager yields
  skills-only catalog.
- **Refine parser:** `grantedSkills`/`grantedMcpTools` parsed; absent → `[]`.
- **ContractValidator:** unknown grant rejected; denied grant rejected; valid
  grant passes.
- **WorkerLoop filter:** granted MCP tool becomes visible; denylisted granted
  tool stays hidden; persona-denied tool stays hidden even if granted.
- **Skill injection:** granted skill body appears in the worker prompt even when
  absent from `persona-skill-map.json`.
- **Pipeline integration:** a task granted a skill + MCP tool runs end-to-end with
  both present; kill-switch disables all granting.

## Open questions / risks

- **Worker host ≠ MCP registry** (see §3 verification). Resolve early; if the
  worker host lacks MCP adapters, granting MCP names is inert until wired.
- **Token cost** of the catalog in the refine prompt scales with skill/MCP count;
  the brief (one line each) keeps it bounded, but a large MCP surface may need a
  cap or relevance pre-filter (deferred unless it bites).
