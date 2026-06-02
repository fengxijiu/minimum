---

name: learn-skill-writer
description: Use when the /learn command needs to extract reusable workflow knowledge from the current session and write it as a project-local learned SKILL.md file
tags:

* system
* learned-skill
* prompt-engineering
* skill-authoring
* context-extraction

---

# Learn Skill Writer

## Purpose

This skill is used by the `/learn` command.

Its only responsibility is to transform the current conversation or session context into a reusable project-local `SKILL.md` file.

It must not write memory.
It must not modify persona files.
It must not rewrite pipeline architecture.
It must not persist secrets, credentials, or private one-off details.

The output of this skill should be a high-quality learned skill that can later be loaded through the project's skill system and executed with `/skill run <name>`.

---

## Operating Scope

The `/learn` command is restricted to **skill generation and skill persistence**.

Allowed outputs:

```text
.minimum/skills/learned/<skill-name>/SKILL.md
.minimum/skills/learned/<skill-name>/metadata.json
.minimum/learn/drafts/<draft-id>.json
```

Disallowed outputs:

```text
.minimum/memory/*
.minimum/personas/*
src/personas/*
src/skills/BuiltinSkills.ts
global memory
user profile memory
secret stores
credential files
```

The learned skill must be project-local unless the user explicitly requests a different scope.

---

## When to Use

Use this skill when:

* the user invokes `/learn`
* the system needs to summarize current context into a reusable skill
* the context contains a workflow, rule, pattern, checklist, methodology, or prompt constraint that may be useful in future tasks
* the user wants the learned behavior to become available through the skill system
* the desired result is a `SKILL.md` file, not a memory entry or persona patch

Do not use this skill when:

* the context only contains a one-off answer
* the context contains temporary debugging details
* the context contains credentials, tokens, passwords, private keys, or sensitive identifiers
* the user wants to save project facts as memory
* the user wants to change a persona directly
* the user asks for a normal summary rather than a reusable skill

---

## Input Contract

The `/learn` command should provide the following context:

```ts
interface LearnSkillInput {
  projectRoot: string;
  preferredName?: string;
  messages: Array<{
    type: "user" | "assistant" | "system" | "tool";
    text?: string;
  }>;
  currentTask?: string;
  existingSkillNames?: string[];
  maxContextChars?: number;
}
```

The skill writer should treat the input context as noisy. It must extract only stable, reusable, future-facing knowledge.

---

## Output Contract

The skill writer must produce a draft object:

```ts
interface LearnedSkillDraft {
  id: string;
  name: string;
  description: string;
  tags: string[];
  body: string;
  targetDir: string;
  targetPath: string;
  createdAt: number;
  source: {
    projectRoot: string;
    messageCount: number;
  };
  warnings: string[];
}
```

The rendered `SKILL.md` must follow this structure:

```md
---
name: <skill-name>
description: Use when <specific trigger condition>
tags:
  - learned
  - ...
---

# <Human Readable Skill Title>

## Purpose

...

## When to Use

...

## Inputs

...

## Core Workflow

...

## Output Contract

...

## Rules and Constraints

...

## Verification Checklist

...

## Failure Modes

...
```

---

## Naming Rules

The skill name must be a slug.

Valid:

```text
pipeline-loop-check
learn-skill-writer
repo-context-compression
persona-constraint-review
```

Invalid:

```text
Pipeline Loop Check
pipeline_loop_check
learn skill writer
/learn-prompt
```

Slug rules:

```text
lowercase only
letters, numbers, and hyphens only
no leading hyphen
no trailing hyphen
maximum 80 characters
```

If the user provides `--name`, normalize it into a slug.

Example:

```text
/learn --name "W3.5 回环检测"
```

Should become:

```text
w3-5-loop-check
```

If no name is provided, infer a concise name from the reusable pattern.

---

## Description Rules

The `description` field is used by the skill loader to decide when to load the skill.

Therefore:

* it must begin with `Use when`
* it must describe trigger conditions
* it must not summarize the full workflow
* it must not be vague
* it must not include implementation noise from the current session

Good:

```yaml
description: Use when validating pipeline output before final delivery and deciding whether incomplete work should return to planning
```

Bad:

```yaml
description: This skill summarizes our discussion about adding W3.5 after W3 using master_planner and updating the pipeline
```

Bad:

```yaml
description: Use this skill for everything related to planning
```

---

## Extraction Rules

When analyzing the session context, classify each piece of information:

| Type                          | Action                                              |
| ----------------------------- | --------------------------------------------------- |
| reusable workflow             | include in skill                                    |
| project-wide stable rule      | include only if needed for this skill               |
| user preference               | include only if it affects this skill directly      |
| persona behavior              | describe as workflow behavior, not persona mutation |
| one-off implementation detail | omit                                                |
| temporary error or log        | omit unless it teaches a reusable failure mode      |
| credential or secret          | omit and warn                                       |
| private personal detail       | omit unless explicitly necessary and safe           |
| exact chat transcript         | omit                                                |

The learned skill should not be a transcript. It should be a distilled operating procedure.

---

## Skill Body Requirements

A high-quality learned skill should contain:

1. **Purpose**
   Explain what reusable capability this skill provides.

2. **When to Use**
   Define precise trigger conditions.

3. **Inputs**
   Define what context the skill expects.

4. **Core Workflow**
   Give the step-by-step reusable method.

5. **Decision Rules**
   Include branching logic and acceptance criteria.

6. **Output Contract**
   Define the expected final response or generated artifact.

7. **Rules and Constraints**
   Include hard constraints learned from the session.

8. **Verification Checklist**
   Provide a checklist to validate correct application.

9. **Failure Modes**
   List common mistakes and how to avoid them.

10. **Minimal Example**
    Include a compact example only if it improves future use.

---

## Core Workflow for `/learn`

When `/learn` is invoked, follow this workflow:

### 1. Compress Context

Extract the useful portion of the session.

Prioritize:

```text
recent user instructions
explicit constraints
repeated preferences
workflow definitions
architecture decisions
command semantics
acceptance criteria
```

Deprioritize:

```text
tool logs
raw stack traces
temporary errors
duplicate assistant explanations
one-off examples
unconfirmed speculation
```

### 2. Identify the Reusable Pattern

Ask:

```text
Would this help solve a future task?
Is it a method, workflow, checklist, or reusable constraint?
Can it be applied without the original chat?
Does it belong in a skill rather than memory?
```

If the answer is no, reject the candidate.

### 3. Generate a Skill Name

Infer the smallest accurate name.

The name should describe the reusable behavior, not the chat topic.

Example:

```text
Context: "在 W3 后增加 W3.5 做回环检测"
Skill name: pipeline-loop-check
```

### 4. Generate Frontmatter

Required frontmatter:

```yaml
name: <slug>
description: Use when <trigger condition>
tags:
  - learned
```

Optional tags may include:

```text
pipeline
review
planning
code-quality
debugging
documentation
repo-analysis
prompting
skill-authoring
```

### 5. Generate the Skill Body

Write the body as a reusable instruction document.

Do not say:

```text
In this conversation, the user asked...
Earlier we discussed...
The assistant suggested...
```

Instead say:

```text
When validating pipeline output, perform an acceptance review before final delivery.
```

### 6. Validate the Skill

Before returning the draft, check:

```text
name is a valid slug
description starts with "Use when"
description describes trigger conditions
body is reusable
body does not contain secrets
body does not contain raw chat transcript
body does not modify memory or persona
body has a verification checklist
body has clear output contract
```

### 7. Return Draft

Return the complete `LearnedSkillDraft`.

The caller may preview it, save it as draft JSON, or write it to disk.

---

## Hard Constraints

The generated skill must obey these constraints:

```text
1. Generate only learned skill content.
2. Do not create or update memory files.
3. Do not create or update persona files.
4. Do not edit built-in skill source code.
5. Do not store credentials, tokens, passwords, private keys, or API keys.
6. Do not store raw private user data.
7. Do not preserve noisy chat transcript.
8. Do not generate multiple unrelated skills from one /learn call unless explicitly requested.
9. Do not overwrite an existing learned skill without conflict handling.
10. Do not claim the skill has been written unless the write operation succeeded.
```

---

## Conflict Handling

If the target skill already exists:

```text
.minimum/skills/learned/<skill-name>/SKILL.md
```

Do not overwrite silently.

Return one of these actions:

```text
needs_rename
needs_update_confirmation
needs_merge_confirmation
```

Suggested response:

```text
A learned skill named "<skill-name>" already exists.

Options:
- /learn apply <draft-id> --rename <new-name>
- /learn apply <draft-id> --overwrite
- /learn apply <draft-id> --merge
```

Default behavior: refuse overwrite.

---

## Sensitive Information Filter

Before writing the skill, scan for sensitive content.

Reject or remove content containing:

```text
password
token
api key
secret
private key
ssh key
cookie
authorization header
bearer token
database url
email verification code
phone number
government id
exact private address
```

If sensitive content is found, add a warning:

```text
Sensitive content was detected and removed from the learned skill draft.
```

Never include the sensitive value in the warning.

---

## Quality Bar

A learned skill is acceptable only if it is:

```text
reusable
specific
self-contained
small enough to load as context
free of secrets
free of raw transcript noise
clear about when to use
clear about what to output
clear about how to verify success
```

Reject low-quality skills.

Examples of low-quality learned skills:

```text
"how to answer this exact user"
"summary of today's conversation"
"debug log for one failed command"
"temporary workaround for one machine"
"the user asked for a /learn command"
```

Examples of valid learned skills:

```text
pipeline-loop-check
skill-authoring-pattern
repo-analysis-without-structure-change
tui-command-design-review
context-to-skill-distillation
```

---

## Rendering Rules

Render `SKILL.md` exactly as Markdown.

Do not wrap the final file in extra prose.

Do not include code fences around the full `SKILL.md` when writing to disk.

When previewing in chat, code fences are allowed.

The final file must be valid UTF-8.

---

## Recommended Metadata

When writing `metadata.json`, include:

```json
{
  "id": "learn_...",
  "name": "<skill-name>",
  "description": "Use when ...",
  "tags": ["learned"],
  "createdAt": 0,
  "source": {
    "projectRoot": "...",
    "messageCount": 0
  },
  "generatedBy": "/learn",
  "schemaVersion": 1
}
```

---

## Minimal Example

Input context:

```text
User wants a W3.5 loop check after W3.
The master planner should verify whether the task is complete.
If incomplete, new tasks should be sent back to W1.
The pipeline structure should not be rewritten.
```

Generated skill name:

```text
pipeline-loop-check
```

Generated description:

```yaml
description: Use when validating pipeline output before final delivery and deciding whether incomplete work should return to planning
```

Generated core workflow:

```md
## Core Workflow

1. Read the original task objective.
2. Inspect W3 implementation output.
3. Compare completed work against the original task.
4. Identify missing functional, test, integration, documentation, and constraint requirements.
5. Decide one of:
   - pass to final delivery
   - return to planning with new tasks
   - request clarification
6. Produce an acceptance decision with evidence.
```

---

## Final Self-Check

Before returning a learned skill draft, verify:

```text
[ ] The skill has valid YAML frontmatter.
[ ] The name is a valid slug.
[ ] The description starts with "Use when".
[ ] The skill is reusable.
[ ] The skill is not a memory entry.
[ ] The skill is not a persona patch.
[ ] The skill does not include secrets.
[ ] The skill does not include raw transcript noise.
[ ] The skill has a clear workflow.
[ ] The skill has an output contract.
[ ] The skill has a verification checklist.
[ ] The skill can be loaded by /skill run <name>.
```

If any required check fails, return a draft warning instead of applying automatically.
