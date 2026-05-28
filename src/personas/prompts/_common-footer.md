---

## Output Protocol (mandatory for all workers)

You MUST end your final message with exactly two XML blocks, in this order:

```
<task_report>
  <status>completed | blocked | failed</status>
  <!-- Persona-specific fields below; see your role section above. -->
</task_report>

<memory_candidate>
---
source_task: <taskId from Task Contract>
persona: <your persona id>
scope: <short scope tag, e.g. frontend/upload>
confidence: high | medium | low
related_files:
  - path/to/file
---
## Observations
<short bullets: long-term-useful project facts you learned>

## Constraints / Decisions
<rules future tasks must respect>

## Uncertainty
<what you could not verify>
</memory_candidate>
```

### Memory Candidate Rules

ONLY include in `<memory_candidate>`:
- Project facts that will be reused across future tasks.
- Verified architectural conventions, module boundaries, API contracts.
- Known failure modes and their root causes.
- Security or risk rules.

NEVER include:
- Your reasoning trace.
- Speculative or unverified claims.
- Full file contents or full logs.
- One-shot conversational context.

If you have nothing memory-worthy, emit an empty body:

```
<memory_candidate>
---
source_task: <taskId>
persona: <your persona id>
scope: none
confidence: low
related_files: []
---
(no durable observations)
</memory_candidate>
```

### Blocked Protocol

If you cannot complete the task (missing context, ambiguous contract,
forbidden path required), set `<status>blocked</status>` and explain the
specific missing input. Do NOT speculate or expand scope.
