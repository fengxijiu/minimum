# Integrated Implementation Plan: Multi-Persona Orchestrator + Memory Governance

> Combines two design tracks — the multi-role task compiler (master_planner + 10
> workers) and the `.minimum/` memory governance system — into a single
> orchestrator. The two systems are deeply coupled: master_planner is also the
> Memory Governor; ContextBuilder is also a memory chunker; W4 finalize is also
> the memory merge step.

## 1. Architecture in one diagram

```
W0  master_planner
    ├─ MemoryLoader.load(taskType)  ← .minimum/*.md
    └─ compileCoarse()  → coarse Task DAG

W1  perception (parallel):  vision / repo_scout / context_builder
    └─ each worker → _staging/<taskId>.<persona>.memory.md

W0.5 master_planner.refine()
    └─ produces final Task Contracts (allowedGlobs locked in)

W2  implementation (parallel, same-file mutex):  code_executor × N
    └─ patches/ + _staging/*.memory.md

W3  validation (parallel):  test_writer / test_runner / reviewer / runtime_debug
    └─ _staging/*.memory.md

W4  master_planner.finalize()  — single LLM call:
    ├─ patch merge plan
    ├─ memory governance (merge/reject/archive/update)
    └─ clear _staging/, write tasks/<epic>/plan.yaml
```

## 2. Module layout

```
src/personas/                 # role registry
  Persona.ts
  PersonaRegistry.ts
  prompts/*.md
src/orchestration/             # task compiler & scheduler
  TaskContract.ts
  ContractValidator.ts
  TaskCompiler.ts
  TaskGraph.ts
  Refiner.ts
  WaveScheduler.ts
  TaskRunner.ts
src/memory/governance/         # memory layer
  MemoryStaging.ts
  MemoryGovernor.ts
  MemoryLoader.ts
  MemoryManifest.ts
  MemoryScorer.ts
  ContextPackBuilder.ts
  types.ts
src/tools/policy/
  PathPolicyEnforcer.ts
  ToolAllowlistEnforcer.ts

.minimum/
  manifest.yaml
  *.md                        # canonical memory
  _staging/<taskId>.<persona>.memory.md
  _archive/YYYY-MM/
  tasks/<epic>/
    plan.yaml
    reports/<taskId>.<persona>.json
    patches/<taskId>.patch
    context-packs/<taskId>.md
    artifacts/<taskId>.<role>.json
```

## 3. Four coupling points

1. **W0 boot** — `MemoryLoader` injects canonical memory as system prefix for
   `master_planner` only; subagents do not see it.
2. **W1 → W2 handoff** — `ContextBuilder` extracts relevant canonical memory
   sections per downstream Persona and writes a per-task ContextPack.
3. **Worker output** — every Persona emits two XML blocks: `<task_report>` and
   `<memory_candidate>`; `TaskRunner` files them separately.
4. **W4 single call** — `master_planner` decides patch merge order AND memory
   merge actions in one LLM call with structured JSON output (zod-validated).

## 4. Phased, graded TODO

| Grade | PR  | Scope                                                            | LOC  |
| ----- | --- | ---------------------------------------------------------------- | ---- |
| **S** | P1  | Persona + PersonaRegistry + 10 prompt files + _common-footer.md  | ~450 |
| **S** | P2  | TaskContract + ContractValidator + zod schemas                   | ~250 |
| **S** | P3  | MemoryStaging + MemoryManifest + MemoryScorer + memory types     | ~350 |
| **A** | P4  | PathPolicyEnforcer + ToolAllowlistEnforcer (write-path guards)   | ~300 |
| **B** | P5  | TaskCompiler (coarse) + TaskGraph + MemoryLoader (W0 injection)  | ~500 |
| **B** | P6  | WaveScheduler + TaskRunner (parallel exec, dual-output capture)  | ~500 |
| **C** | P7  | ContextPackBuilder (memory excerpting per downstream Persona)    | ~300 |
| **C** | P8  | Refiner (W0.5 second-pass compilation)                           | ~250 |
| **C** | P9  | MemoryGovernor + W4 single-call finalize (zod-strict)            | ~450 |
| **D** | P10 | MiMoLoop wiring + UiEvent extensions + TUI pipeline view + /memory | ~400 |
| **D** | P11 | E2E: image-upload demo across W0–W4 + memory persistence check   | ~300 (tests) |

**Grade meaning**
- **S** = Foundational primitives. No business logic depends on them being correct beyond their type contracts. Lowest risk to land first.
- **A** = Safety nets. Hard guards that prevent regressions later phases would otherwise be vulnerable to.
- **B** = Orchestration core. The control flow lives here.
- **C** = Intelligence layer. LLM-driven refinement and merging.
- **D** = Integration & validation.

## 5. Per-PR workflow (mandatory)

```
implement → npm test (all green) → /simplify-style self-review →
commit with descriptive message → git push
```

If any step fails: stop, fix root cause, re-run. Do not stack PRs on a red base.

## 6. Invariants (assertion-level, tested in every PR after relevant module lands)

1. No Persona except `master_planner` writes to `.minimum/*.md` (canonical).
2. No Task starts without `ContractValidator.validate()` returning ok.
3. After W4, `.minimum/_staging/` is empty (unless LLM JSON parse fails).
4. Every merged memory entry has `source_task`, `persona`, `related_files`.
5. Subagent system prompt contains the ContextPack — never the raw canonical memory.
6. Same-`parallelGroup` tasks have disjoint `allowedGlobs`.
7. `MemoryLoader` output ≤ 8k tokens (hard cap, truncate-with-warning).

## 7. Out of scope (deferred / never)

- Inter-agent messaging (artifacts flow via file paths)
- Dynamic Persona creation (10 fixed; extension by code change)
- Vector embeddings over `.minimum` (full-text + taskType filter suffices)
- Cross-epic staging state (each epic has its own staging window)
- Schema migration tools for `.minimum` (the user owns git as version control)
