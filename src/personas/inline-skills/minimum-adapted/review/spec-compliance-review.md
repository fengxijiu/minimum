# Spec Compliance Review

## Purpose
Make reviewer check the Task Contract before code quality.

## Rules
- First compare patch scope against `allowedGlobs`, `nonGoals`, and `acceptance`.
- Contract violations are blocking regardless of code quality.
