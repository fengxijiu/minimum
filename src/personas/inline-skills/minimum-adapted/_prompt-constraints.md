# Global Prompt Constraints

## Priority
These constraints refine the existing Minimum persona prompts. They do not change tool allowlists, path policy, or persona identity.

## Contract Boundary
Every write-capable task must include `allowedGlobs`, `acceptance`, `nonGoals`, and `blockedCondition` before launch.

## Evidence Rule
Never claim tests, review, or verification passed without concrete command output or an explicit waiver.

## Context Rule
Workers receive bounded task context. Do not assume full-repository context unless the Task Contract provides it.

## Superpowers Adaptation
Use Minimum-native TaskContract dispatch instead of upstream fresh-subagent instructions.
