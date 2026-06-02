# Skill: Persona Skill Router

## Purpose

This skill is responsible for assigning newly learned or installed skills to suitable personas during `/learn` and `/skill install`.

It does not modify persona definitions directly.

It only writes routing metadata into skill files and skill registry files, so personas can dynamically load relevant skills at runtime.

## Boundaries

This skill may:

* Analyze a new skill’s capability scope.
* Infer which workflow stages may benefit from the skill.
* Infer which personas should load the skill.
* Generate persona assignment metadata.
* Ask the user to confirm ambiguous assignments.
* Update skill registry files.
* Update persona-skill mapping files.

This skill must not:

* Rewrite existing persona prompts.
* Override persona behavior globally.
* Store data in memory.
* Modify workflow stage order.
* Add new workflow stages.
* Add new personas unless explicitly requested.
* Install a learned skill without writing a valid `SKILL.md`.

## Input Sources

The router may receive input from:

```text
/learn
/learn --name <skill-name>
/learn --dry-run
/skill install <skill-path-or-package>
/skill install --persona auto
/skill install --persona <persona-id>
```

The router should inspect:

```text
1. Skill title
2. Skill description
3. Trigger conditions
4. Input/output format
5. Required tools
6. Workflow stage affinity
7. Persona compatibility
8. Risk level
9. Conflict with existing skills
```

## Output Files

The router writes or updates:

```text
.minimum/skills/learned/<skill-name>/SKILL.md
.minimum/skills/index.json
.minimum/skills/persona-skill-map.json
.minimum/learn/drafts/<skill-name>.json
```

## Skill Metadata Schema

Every learned or installed skill should contain this metadata block near the top of `SKILL.md`:

```yaml
---
skill_id: <skill-name>
skill_type: learned | installed | system
version: 1.0.0
source: learn | skill_install | manual
status: active | draft | disabled

applies_to_personas:
  - <persona-id>

stage_affinity:
  - W0
  - W0.5
  - W1
  - W2
  - W3
  - W3.5
  - W4

routing:
  mode: auto
  priority: 50
  confidence: 0.0
  requires_confirmation: true
  conflict_policy: prefer_more_specific_skill

triggers:
  - <natural-language trigger>
  - <keyword trigger>

capability_tags:
  - planning
  - coding
  - review
  - testing
  - refactor
  - documentation
  - context_learning
  - persona_routing

safety:
  can_modify_code: false
  can_modify_persona: false
  can_modify_workflow: false
  can_write_skill: true
---
```

## Persona Assignment Rules

The router should assign a skill to a persona by evaluating the following dimensions.

### 1. Stage Affinity

Infer which workflow stage the skill supports.

```text
W0      requirement intake / initial understanding
W0.5    context normalization / constraint extraction
W1      planning / task decomposition
W2      implementation / execution
W3      review / validation
W3.5    loop checking / acceptance / regression decision
W4      final delivery / packaging / user-facing summary
```

A skill can belong to multiple stages, but should prefer the smallest useful set.

### 2. Persona Affinity

Assign by matching skill capability to persona responsibility.

Examples:

```text
planning skill        → master_planner
task split skill      → master_planner
code generation skill → coder / developer persona
review skill          → reviewer / critic persona
test skill            → tester / verifier persona
loop-check skill      → W3.5 loop checker persona
delivery skill        → final responder / packager persona
```

If exact persona names are unknown, the router should use stage-level routing first and request confirmation before writing the final map.

### 3. Trigger Specificity

Prefer specific trigger matches over broad matches.

```text
"optimize persona prompt" > "optimize"
"generate regression decision" > "review"
"convert current context into SKILL.md" > "learn"
```

### 4. Conflict Policy

When multiple skills match the same persona and trigger:

```text
1. Prefer system skill over learned skill if the task is infrastructure-level.
2. Prefer learned skill if it is more specific to the current project.
3. Prefer higher confidence.
4. Prefer higher priority.
5. If still tied, load both but order them by priority.
```

## Assignment Confidence

The router should output a confidence score.

```text
0.90 - 1.00  Direct match, safe to auto-assign
0.70 - 0.89  Strong match, ask for lightweight confirmation
0.50 - 0.69  Possible match, show alternatives
0.00 - 0.49  Do not assign automatically
```

## Required Interactive Confirmation

Before applying the assignment, the router should show:

```text
Skill: <skill-name>

Detected capability:
- <summary>

Recommended persona assignment:
- <persona-id> because <reason>

Recommended stage affinity:
- <stage-id> because <reason>

Confidence:
- <score>

Write targets:
- .minimum/skills/learned/<skill-name>/SKILL.md
- .minimum/skills/index.json
- .minimum/skills/persona-skill-map.json

Options:
1. apply
2. edit personas
3. edit stages
4. dry-run only
5. cancel
```

The router must not silently apply uncertain assignments.

## `/learn` Behavior

When the user runs:

```text
/learn
```

The system should:

```text
1. Collect the current conversation context.
2. Extract reusable rules, constraints, examples, and procedures.
3. Generate a learned skill draft.
4. Infer suitable personas.
5. Infer suitable workflow stages.
6. Generate routing metadata.
7. Present a preview.
8. Ask for confirmation.
9. Write the skill to disk only after confirmation.
```

The generated learned skill should be stored at:

```text
.minimum/skills/learned/<skill-name>/SKILL.md
```

A draft copy should be stored at:

```text
.minimum/learn/drafts/<skill-name>.json
```

## `/skill install` Behavior

When the user runs:

```text
/skill install <skill-path-or-package>
```

The system should:

```text
1. Read the incoming skill.
2. Validate whether it contains a valid SKILL.md.
3. Extract metadata if present.
4. If persona routing metadata is missing, infer it.
5. If metadata exists, verify that referenced personas exist.
6. Detect conflicts with existing skills.
7. Generate a persona assignment proposal.
8. Ask for confirmation if confidence is below 0.90 or conflicts exist.
9. Install the skill.
10. Update skill index and persona-skill-map.
```

## Persona Skill Map Format

Suggested path:

```text
.minimum/skills/persona-skill-map.json
```

Suggested schema:

```json
{
  "version": "1.0.0",
  "personas": {
    "master_planner": {
      "skills": [
        {
          "skill_id": "subagent-task-assignment",
          "source": "installed",
          "priority": 90,
          "stage_affinity": ["W1"],
          "enabled": true
        }
      ]
    },
    "w3_5_loop_checker": {
      "skills": [
        {
          "skill_id": "acceptance-loop-check",
          "source": "learned",
          "priority": 85,
          "stage_affinity": ["W3.5"],
          "enabled": true
        }
      ]
    }
  }
}
```

## Skill Index Format

Suggested path:

```text
.minimum/skills/index.json
```

Suggested schema:

```json
{
  "version": "1.0.0",
  "skills": {
    "persona-skill-router": {
      "path": ".minimum/skills/system/persona-skill-router/SKILL.md",
      "type": "system",
      "status": "active",
      "applies_to_personas": ["master_planner"],
      "stage_affinity": ["W0.5", "W1"],
      "priority": 100
    }
  }
}
```

## Runtime Loading Rule

Before each persona runs, the agent runtime should load skills by this order:

```text
1. System skills assigned to persona
2. Installed skills assigned to persona
3. Learned skills assigned to persona
4. Stage-specific skills
5. Trigger-specific skills
```

The runtime should not load every skill globally.

It should only load skills where:

```text
persona_id matches applies_to_personas
OR current_stage matches stage_affinity
OR current_task matches triggers
```

## Prompt Injection Template

At runtime, inject skills into persona context using a bounded block:

```text
<ACTIVE_SKILLS persona="<persona-id>" stage="<stage-id>">
Skill: <skill-id>
Source: <source>
Priority: <priority>
Use when:
- <trigger>

Rules:
- <compressed skill rules>
</ACTIVE_SKILLS>
```

The injected skill content should be compact.

Full `SKILL.md` content should only be loaded when the trigger confidence is high.

## Assignment Prompt

Use this prompt when assigning a skill to personas:

```text
You are the Persona Skill Router.

Given a skill draft and the current persona registry, decide which personas should load this skill.

Do not modify persona definitions.

Return only routing metadata.

Evaluate:
1. What capability does this skill provide?
2. Which workflow stages does it support?
3. Which personas are responsible for those stages?
4. Is the skill general or persona-specific?
5. Does it conflict with existing skills?
6. Should the assignment be automatic or require confirmation?

Output JSON:

{
  "skill_id": "...",
  "detected_capability": "...",
  "recommended_personas": [
    {
      "persona_id": "...",
      "reason": "...",
      "confidence": 0.0
    }
  ],
  "stage_affinity": [
    {
      "stage": "...",
      "reason": "...",
      "confidence": 0.0
    }
  ],
  "routing": {
    "mode": "auto",
    "priority": 50,
    "requires_confirmation": true,
    "conflict_policy": "prefer_more_specific_skill"
  },
  "conflicts": [],
  "write_targets": []
}
```

## Validation Rules

Before writing files, validate:

```text
1. skill_id is unique.
2. SKILL.md exists.
3. applies_to_personas is non-empty.
4. every persona exists in persona registry.
5. stage_affinity uses valid stage ids.
6. priority is between 0 and 100.
7. confidence is between 0.0 and 1.0.
8. no system skill is overwritten by learned skill.
9. no persona prompt file is modified.
10. no workflow file is modified unless explicitly requested.
```

## Failure Modes

If persona detection fails:

```text
- Save the skill as draft.
- Mark status as draft.
- Do not update persona-skill-map.
- Ask user to choose persona manually.
```

If skill conflicts with existing skill:

```text
- Show conflict list.
- Recommend merge, disable old skill, or install with lower priority.
- Do not silently overwrite.
```

If install source is invalid:

```text
- Abort install.
- Explain missing fields.
- Do not write partial files.
```

## Minimal Command Contract

Supported commands:

```text
/learn
/learn --name <skill-name>
/learn --dry-run
/learn preview <draft-id>
/learn apply <draft-id>

/skill install <path>
/skill install <path> --persona auto
/skill install <path> --persona <persona-id>
/skill install <path> --dry-run
```

## Expected Result

After `/learn` or `/skill install`, the system should know:

```text
1. What the skill does.
2. Which persona should receive it.
3. Which workflow stage should use it.
4. When to activate it.
5. Where the skill is stored.
6. Whether the assignment was user-confirmed.
```
