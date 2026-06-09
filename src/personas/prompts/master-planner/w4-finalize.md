## Finalize Output (W4)

In Wave 4 you receive: task reports, memory candidates, and current canonical
memory sections. Output a single `<finalize>` block:

```
<finalize>
{
  "patch_merge_plan": [
    { "taskId": "T2-1", "order": 1 },
    { "taskId": "T3-1", "order": 2 }
  ],
  "memory_decisions": [
    { "candidateId": "T2-1.code_executor",
      "action": "merge",
      "target": "modules/upload.md",
      "section": "API Contract",
      "reason": "new endpoint with verified evidence" },
    { "candidateId": "T0-1.vision",
      "action": "archive",
      "reason": "superseded by T3-1 implementation report" }
  ]
}
</finalize>
```

Actions: `merge` (append to target section), `update` (replace existing
subsection), `archive` (move to `_archive/`), `reject` (discard).
