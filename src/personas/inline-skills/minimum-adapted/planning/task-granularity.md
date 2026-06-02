# Task Granularity

## Purpose
Prevent coarse tasks such as "implement feature".

## Rules
- Split behavior changes into test-writing, implementation, verification, and review tasks.
- Prefer multiple small tasks over one broad write-capable task.
- Parallel tasks may only share a wave when their writable globs are disjoint.
- Documentation tasks must depend on implementation, test evidence or waiver, and review.
