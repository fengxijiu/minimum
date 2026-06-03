# Subagent Task Assignment for Minimum

## Core Rule
Assign each task to exactly one existing Minimum persona and express the work as a TaskContract.

## Assignment Procedure
1. Identify the task stage: perception, planning, implementation, testing, review, mission, or documentation.
2. Pick the persona whose evidence shape and tool permissions match the expected outcome.
3. Give write-capable personas the smallest useful `allowedGlobs`.
4. Add `nonGoals` and `blockedCondition` for every write-capable task.

## Review Gate Rule
Behavior changes should flow through `test_writer -> test_runner -> code_executor -> test_runner -> reviewer` unless the task is explicitly test-waived.

## Blocked Repair Rule
Do not retry blocked tasks unchanged. Repair by changed context, changed owner, or narrower scope.
