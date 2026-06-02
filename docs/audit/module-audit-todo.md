# Module Audit TODO
Generated: 2026-06-02

## Audit Scope
Full review of all modules for correct wiring to TUI and engine, no TypeScript errors.

---

## Section A — Compilation & Type Safety
- [x] A1. Root package (`npx tsc -p tsconfig.json --noEmit`) — zero errors
- [x] A2. TUI package (`npx tsc -p tui/tsconfig.json --noEmit`) — zero errors
- [x] A3. All test files compile (`npx tsc -p tsconfig.json --noEmit` includes tests)

## Section B — Engine Core (src/loop, src/bridge, src/config)
- [x] B1. `MiMoLoop` — all config fields used, `skillsSystemContent` wired
- [x] B2. `EngineBridge` — all UiEvent kinds handled, approval/permission loop correct
- [x] B3. `PipelineBridge` — sends UiEvents for W0–W4 + W3.5 phases
- [x] B4. `createMiMoStack` — all builtins registered (choice, shell, jobs, code-query)
- [x] B5. `engine.ts` (TUI) — runner interface fully implemented, skillsSystemContent wired

## Section C — Tools
- [x] C1. ReadFileTool, WriteFileTool, EditFileTool, ApplyPatchTool registered in engine.ts
- [x] C2. GlobTool, ListDirectoryTool, GrepTool registered
- [x] C3. GitTool registered
- [x] C4. WebFetchTool registered
- [x] C5. TodoWriteTool registered
- [x] C6. ExecShellTool — registered via createMiMoStack, approval-gated
- [x] C7. RunBackgroundTool, JobOutputTool, WaitForJobTool, StopJobTool, ListJobsTool registered
- [x] C8. ChoiceTool — registered via createMiMoStack, TuiConfirmationGate wired
- [x] C9. SymbolsTool, CodeQueryTool registered
- [x] C10. All tools visible to model via `tools.getDefinitions()` on every turn

## Section D — TUI Commands (tui/src/commands.ts + app.tsx)
- [x] D1. All COMMANDS entries have a handler in runCommand()
- [x] D2. `/learn` subcommands: create, preview, apply, reject, status all handled
- [x] D3. `/skill` subcommands: list, info, run, <name> shorthand all handled
- [x] D4. `/permission` modes: read-only, auto-edit, full-auto
- [x] D5. `/plan` modes: on, off, <task>, no-arg status
- [x] D6. `/mode` cycling: agent, chat, orchestrate
- [x] D7. `/orchestrate` → pipelineRunner
- [x] D8. `/save`, `/load`, `/sessions` session persistence
- [x] D9. `/init` project initialization
- [x] D10. Permission overlay — allow once / always allow / deny
- [x] D11. Choice overlay (ChoiceBar) — pick, cancel, navigate
- [x] D12. All CommandOutcome kinds handled in applyOutcome()

## Section E — Learn Pipeline
- [x] E1. LearnCommandService.create() — generateWithModel wired to runner.completeText
- [x] E2. LearnCommandService.preview() — returns rendered markdown
- [x] E3. LearnCommandService.apply() — writes SKILL.md + metadata.json + routing
- [x] E4. LearnCommandService.reject()
- [x] E5. LearnCommandService.status() — returns drafts + learnedSkills
- [x] E6. PersonaSkillRouter.inferRoute() — scored multi-keyword matching
- [x] E7. PersonaSkillRouter.buildRoutingMetadata() — confidence threshold correct
- [x] E8. PersonaSkillRouter.writePersonaSkillRouting() — writes index.json + persona-skill-map.json
- [x] E9. reloadSkills after apply — next turn picks up new skills automatically
- [x] E10. /learn status output — grouped by status with actionable commands

## Section F — Skills System
- [x] F1. Inline skills (SkillRegistry) — full bodies always in persona.systemPrompt
- [x] F2. renderInlineSkillsExpandedForPersona() — exists for future use, not called in pipeline
- [x] F3. Learned skills — two-tier in loadProjectSkillPrompt (brief catalog + objective expansion)
- [x] F4. Single-agent learned skills — two-tier via skillsSystemContent in engine.ts
- [x] F5. loadLearnedSkills exported from src/index.ts
- [x] F6. SKILL.md brief extraction in readLearnedSkillBrief()

## Section G — Memory System
- [x] G1. SingleAgentMemoryManager wired to MiMoLoop in createMiMoStack
- [x] G2. Memory prelude injected per-turn in MiMoLoop.refreshMemoryPrelude()
- [x] G3. Memory writeback at turn end in MiMoLoop.writebackMemory()
- [x] G4. governance/index.ts exports consistent with usage
- [x] G5. .minimum/memory.md path shown in /memory command

## Section H — Pipeline / Orchestration
- [x] H1. MiMoPipeline.runPipeline() — W0→W1→W2/3→W3.5→W4 phases all emitted as pipeline events
- [x] H2. createPlannerBridge — sys(objective) passes userRequest to compile
- [x] H3. createWorkerExecutor — projectSkills two-tier, inline skills full
- [x] H4. PipelineBridge → PipelineZone in TUI renders phases
- [x] H5. W_PHASES set in app.tsx matches all emitted phase strings

## Section I — State Management (tui/src/state/)
- [x] I1. All AgentEvent types handled in reducer
- [x] I2. AppState shape matches all dispatch calls in app.tsx
- [x] I3. PendingState: null | 'permission' | 'error' | 'choice' — all paths handled
- [x] I4. useSlice() — no stale state issues

## Section J — Tests
- [x] J1. `npx vitest run` — all unit tests pass
- [x] J2. persona-skill-router.test.ts — passes with new scoring
- [x] J3. learn-service.test.ts — passes
- [x] J4. learn-command.test.ts — passes

---
**Total items: 54**
