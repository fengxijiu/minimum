# Persona Skill Router

## Purpose
Assign newly learned or installed skills to suitable Minimum personas and workflow stages.

## Boundaries
The router writes routing metadata only. It does not modify persona definitions, tool allowlists, path policy, or workflow stage definitions.

## Output Files
- `.minimum/skills/index.json`
- `.minimum/skills/persona-skill-map.json`

## Persona Assignment Rules
- Planning and dispatch skills map to `master_planner`.
- Review skills map to `reviewer`.
- Test evidence skills map to `test_runner`; test authoring skills may map to `test_writer`.
- Documentation skills map to `docs`.
- Implementation skills map to `code_executor`.

## Assignment Confidence
- `0.90 - 1.00`: direct match, safe to auto-assign.
- `0.70 - 0.89`: strong match, ask for lightweight confirmation.
- `0.50 - 0.69`: possible match, show alternatives.
- `<0.50`: do not assign automatically.

## Runtime Loading Rule
Load skills in this order: global constraints, persona base prompt, system skills, learned/installed skills assigned to persona, task ContextPack, common footer.

## Validation Rules
Do not silently apply uncertain assignments. Do not write partial routing files.
