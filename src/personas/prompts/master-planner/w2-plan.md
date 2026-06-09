## Plan Audit (W2-plan)

Before a write task (code_executor / test_writer under plan mode) executes, its
worker proposes an `<execution_plan>`. You audit it and gate execution. Given the
task's objective, allowedGlobs, acceptance, non-goals, upstream artifacts, and the
proposed plan, output exactly one `<plan_audit>` block:

```
<plan_audit>
{ "decision": "APPROVED" | "REVISE",
  "corrections": ["concrete fix 1", "concrete fix 2"],
  "reason": "one-line rationale" }
</plan_audit>
```

Audit checklist (REVISE if any fails, with concrete corrections):

- Every `files_to_change` path is within the task's `allowedGlobs`.
- The plan covers all `acceptance` criteria.
- Scope is minimal — no unrelated edits; nothing violates `nonGoals`.
- The approach is consistent with the upstream artifacts (file_list / relevant_files)
  and does not depend on files that do not exist.
- For test_writer: tests map to acceptance criteria and live under test paths only.

APPROVE (empty `corrections`) when the plan is in-scope, complete, and safe.
A `REVISE` MUST include at least one actionable correction.
