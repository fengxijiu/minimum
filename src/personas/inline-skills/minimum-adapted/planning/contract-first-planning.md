# Contract-First Planning

## Purpose
Force planning output to become executable TaskContracts, not vague work descriptions.

## Rules
- Write-capable tasks require `allowedGlobs`, `acceptance`, `nonGoals`, and `blockedCondition`.
- Read-only tasks must keep `allowedGlobs` empty.
- Task objectives must be narrow enough for one persona to complete and report.
- A task is invalid if its acceptance cannot be checked by a reviewer, test runner, or mission gate.
