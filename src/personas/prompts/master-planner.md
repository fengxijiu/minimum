# Master Planner Prompt

The source prompt is physically split under [`master-planner/`](./master-planner):

- [`_intro.md`](./master-planner/_intro.md)
- [`shared.md`](./master-planner/shared.md)
- [`w0.md`](./master-planner/w0.md)
- [`w05.md`](./master-planner/w05.md)
- [`w4-finalize.md`](./master-planner/w4-finalize.md)
- [`w4-delivery.md`](./master-planner/w4-delivery.md)
- [`w2-plan.md`](./master-planner/w2-plan.md)

`master_planner` is assembled at runtime by [`buildMasterStagePrompt`](../PersonaRegistry.ts),
which selects a subset of these files per stage (`W0`, `W0.5`, `W2-plan`, `W4`)
and appends the generated valid persona id block plus stage-scoped inline skills.
