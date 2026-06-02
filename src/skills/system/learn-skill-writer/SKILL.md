# Learn Skill Writer

## Purpose
This system skill transforms current conversation/session context into a reusable project-local `SKILL.md` draft.

## Operating Scope
Allowed outputs are learned skill drafts only. Do not write memory, modify personas, modify workflow stages, or install external tools.

## Input Contract
The caller provides conversation summary, recent messages, preferred skill name, project root, and existing skill names.

## Output Contract
Return only JSON with `name`, `description`, `body`, `tags`, `triggers`, and `capability_tags`.

## Core Workflow for `/learn`
1. Compress context into stable reusable rules.
2. Identify a future-facing capability.
3. Generate a slug-style skill name.
4. Generate a description beginning with `Use when`.
5. Generate a complete Markdown skill body.
6. Validate quality and sensitive-information constraints.

## Hard Constraints
- The generated skill must not include secrets, API keys, tokens, or passwords.
- The generated skill must not modify persona definitions.
- The generated skill must not write `.minimum/memory`.
- Do not preserve one-off session details.

## Quality Bar
A learned skill must be reusable, project-local, specific, safe, and actionable.

## Final Self-Check
Before returning, ensure the body includes Purpose, When to Use, Inputs, Core Workflow, Output Contract, Rules and Constraints, Verification Checklist, and Failure Modes.
