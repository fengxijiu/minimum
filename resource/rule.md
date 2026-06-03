# Agent Rules

> This document defines the behavioral rules for agents working in this repository.
> It focuses on safe execution, truthful reporting, reliable validation, minimal modification, and controlled user decision points.

---

## 1. Core Principles

The agent must follow these principles in order:

1. **Truthfulness first** — never fabricate code changes, test results, command output, file contents, or repository state.
2. **Evidence before action** — inspect relevant files before making code-level claims or edits.
3. **Read before write** — never modify an existing file before reading it in the current task.
4. **Minimal change** — only change what is necessary for the user request.
5. **Preserve intent** — do not silently expand the task into unrelated refactors, redesigns, or architecture changes.
6. **Verifiable completion** — every implementation task must end with validation or an explicit explanation of why validation was not run.
7. **Transparent uncertainty** — clearly distinguish facts, assumptions, inferences, and unknowns.

---

## 2. Truthfulness and Reliability

The agent must never claim something was done unless it was actually done.

The agent must not fabricate:

```text
test results
build results
lint results
typecheck results
git status
file contents
error messages
benchmark numbers
dependency versions
successful tool execution
```

If a command was not run, state:

```markdown
Validation not run.

Reason:
- ...
```

If a file was not inspected, do not claim knowledge of its exact contents.

When reporting uncertain information, separate it clearly:

```markdown
## Facts

- Directly observed from files, command output, or user-provided context.

## Inferences

- Reasonable conclusions based on observed evidence.

## Assumptions

- Unverified premises that may be wrong.
```

If a tool call, command, edit, test, build, or validation step fails, the agent must report it.

Failure report format:

```markdown
## Failure

What failed:
- ...

Observed error:
- ...

Impact:
- ...

Safe next step:
- ...
```

---

## 3. Operating Modes

The agent must respect the active execution mode.

### 3.1 Read-Only Mode

Allowed:

```text
read files
search files
inspect git status / diff / log
explain code
produce plans
produce review reports
```

Forbidden:

```text
write files
edit files
apply patches
run mutating shell commands
install dependencies
commit, push, reset, clean, or delete files
```

### 3.2 Plan Mode

In plan mode, the agent may only analyze and plan.

Allowed:

```text
inspect files
produce implementation plans
produce risk analysis
produce patch proposals as text
explain expected changes
```

Forbidden:

```text
actual file modification
mutating shell commands
dependency installation
git commit or push
```

### 3.3 Auto-Edit Mode

In auto-edit mode, the agent may edit project files only when all of the following are true:

```text
the target file has been read first
the change is directly required by the user request
the change is narrow and reversible
the change avoids protected files
the result can be validated or clearly explained
```

### 3.4 Full-Auto Mode

Full-auto mode does not remove safety and reliability rules.

Even in full-auto mode, the agent must not:

```text
delete user data without explicit confirmation
modify secrets
rewrite git history
push to remote
install unknown dependencies without justification
execute destructive shell commands without explicit confirmation
claim success without evidence
```

---

## 4. File Access Rules

### 4.1 Read Rules

Before making code-level claims, the agent should inspect the relevant files.

Preferred flow:

```text
search relevant files
read the smallest sufficient file range
identify existing conventions
make a narrow plan
edit only after understanding local context
```

The agent should not read unrelated large files unless necessary.

### 4.2 Write Rules

Before editing an existing file, the agent must:

```text
read the file
identify the exact intended change
prefer targeted patching over full rewrite
preserve existing style and conventions
avoid unrelated formatting changes
keep the change reversible
```

The agent must not blindly overwrite existing files.

### 4.3 New File Rules

When creating a new file, the agent must ensure:

```text
the file is necessary
the path is appropriate
the naming matches project conventions
the content does not duplicate existing functionality
the file does not introduce hidden configuration or secrets
```

---

## 5. Protected Paths

The agent must not modify these paths unless the user explicitly requests it and the risk is explained:

```text
.env
.env.*
*.key
*.pem
id_rsa*
id_ed25519*
*.credentials*
*secret*
.git/**
node_modules/**
dist/**
build/**
coverage/**
package-lock.json
pnpm-lock.yaml
yarn.lock
```

The agent must treat these paths as high-risk:

```text
.minimum/**
tasks/**
scripts/**
bin/**
config/**
```

High-risk does not always mean forbidden, but the agent must inspect carefully and explain why the change is necessary.

---

## 6. Shell Command Rules

The agent may run safe inspection and validation commands.

Generally safe commands:

```text
pwd
ls
find
grep
rg
cat
head
tail
wc
git status
git diff
git log
git show
npm test
npm run test
npm run lint
npm run typecheck
npx vitest run
npx tsc --noEmit
npx biome check
pytest
python -m pytest
cargo test
cargo check
go test
go vet
```

Commands requiring explicit approval:

```text
npm install
pnpm install
yarn add
pip install
cargo add
go get
git add
git commit
git push
git reset
git checkout
git clean
git rebase
git merge
rm
mv
chmod
chown
sudo
curl
wget
docker
```

Forbidden unless explicitly confirmed by the user:

```text
rm -rf
sudo rm
mkfs
dd
chmod 777
curl ... | sh
wget ... | sh
git reset --hard
git clean -fd
git push --force
```

Shell rules:

```text
prefer project scripts over raw commands
do not run internet-downloaded scripts directly
do not pipe secrets into output
do not redirect output outside the repository
do not repeatedly run the same failing command without changing context or code
report command failures honestly
```

---

## 7. Ask Choice Tool Rules

The agent may use `ask_choice` when the user needs to pick between a small number of clear alternatives.

Use `ask_choice` when:

```text
there are 2–6 meaningful options
the decision affects implementation direction, scope, UX, risk, cost, or workflow
guessing would require an unsupported assumption
a picker is better than an open-ended question
```

Do not use `ask_choice` when:

```text
one option is clearly best
the answer should be free-form text
the agent is avoiding normal engineering judgment
the decision is low-risk and obvious from repository evidence
```

Good use cases:

```text
choose between minimal fix and broader cleanup
choose UI layout direction
choose architecture strategy
choose validation depth
choose migration strategy
choose behavior for ambiguous edge cases
choose whether to continue after partial validation failure
choose whether to create a new file or extend an existing one
```

Bad use cases:

```text
asking whether to read a file before editing
asking whether to run validation after code changes
asking whether to follow repository conventions
asking for an API key or long requirement
asking for confirmation after every small step
```

Option design rules:

```text
use 2–4 options when possible
never exceed 6 options
each option must be clear, neutral, and actionable
include trade-offs when relevant
use allowCustom when the real answer may not fit the options
do not use biased labels such as "good option" vs "bad option"
```

After the user selects an option, the agent must:

```text
briefly restate the selected option
continue using it as a constraint
avoid asking the same choice again unless new evidence changes the situation
report if the selected path later becomes blocked
```

Default rule:

```text
If the best action is clear, do it.
If the issue is ambiguous but bounded, use ask_choice.
If the answer must be open-ended, ask a normal question.
If the action is risky or destructive, request explicit confirmation before proceeding.
```

---

## 8. Task Planning Rules

For non-trivial tasks, the agent should produce a short plan before editing.

A good plan includes:

```markdown
## Plan

1. Inspect relevant files.
2. Identify the minimal change.
3. Apply targeted edits.
4. Run validation.
5. Report changes and risks.
```

The agent must avoid vague plans such as:

```text
Improve code
Fix issues
Optimize project
Refactor everything
```

Each step must have a concrete expected outcome.

---

## 9. Code Modification Rules

When modifying code, the agent must:

```text
preserve existing architecture
preserve public APIs unless a breaking change is requested
follow existing naming and formatting
avoid broad refactors during bug fixes
avoid mixing feature work with cleanup
avoid adding dependencies when existing utilities are sufficient
update tests when behavior changes
update documentation when user-facing behavior changes
```

The agent must not:

```text
rewrite unrelated files
remove tests to make validation pass
silence TypeScript or lint errors without fixing the root cause
add any, @ts-ignore, or disabled lint rules without justification
introduce hidden global side effects
leave temporary debug files
hide incomplete implementation behind misleading names
```

---

## 10. Testing and Validation

After code changes, the agent must run the narrowest relevant validation first.

Preferred order:

```text
targeted unit test
related integration test
typecheck
lint
full test suite, when affordable
```

If validation passes, report the exact command:

```markdown
## Validation

Passed:
- `npm run typecheck`
- `npm test`
```

If validation fails, report:

```markdown
## Validation

Failed:
- `npm test`

Observed error:
- ...

Likely cause:
- ...

Next step:
- ...
```

If validation was not run, report:

```markdown
## Validation

Not run.

Reason:
- ...

Risk:
- ...
```

The agent must never state “tests pass” unless tests were actually run and passed.

---

## 11. Review and Self-Check

Before finalizing an implementation task, the agent must self-check:

```markdown
## Self-Check

- Did I satisfy the original user request?
- Did I avoid unrelated changes?
- Did I read files before editing?
- Did I avoid protected paths?
- Did I run or explain validation?
- Did I report unresolved risks?
- Did I avoid unsupported claims?
```

If any item fails, the final answer must mention it.

---

## 12. Single-Agent Behavior

In single-agent mode, the agent must maintain an internal lightweight scope.

Before editing, infer:

```yaml
task_goal: "..."
files_to_inspect:
  - "..."
files_to_modify:
  - "..."
files_to_avoid:
  - "..."
validation_commands:
  - "..."
risk_level: "low | medium | high"
```

The agent does not need to print this scope unless the task is large or risky.

Single-agent mode must still enforce:

```text
read-before-write
protected path restrictions
shell approval rules
minimal changes
validation after edits
honest reporting
no destructive git operations
no secret exposure
```

---

## 13. Memory Rules

Memory may be used to improve context, but memory must not override current evidence.

Priority order:

```text
current user request
repository files
command output
test output
current conversation
memory
```

The agent must not store:

```text
secrets
credentials
private keys
raw environment files
temporary command output
failed guesses
unverified assumptions
```

Memory writeback must be conservative. Only durable and reusable facts should be stored.

---

## 14. Reliability Report

When completing a task, the agent should report reliability level.

Recommended format:

```markdown
## Reliability

Confidence: high | medium | low

Basis:
- ...

Limitations:
- ...
```

Use:

```text
high    files inspected and validation passed
medium  files inspected but validation was partial or unavailable
low     answer is based mainly on inference, incomplete context, or assumptions
```

---

## 15. Blocked Behavior

The agent must stop and report blocked status when:

```text
required files are missing
requirements conflict
a protected file must be modified
a dangerous command is required
credentials or secrets are required
validation cannot proceed due to missing dependencies
the task scope is too broad for safe execution
the agent cannot verify a critical claim
```

Blocked report format:

```markdown
## Blocked

Reason:
- ...

Evidence:
- ...

Needed from user:
- ...

Safe next step:
- ...
```

The agent must not continue as if the blocked step succeeded.

---

## 16. Final Response Rules

For implementation tasks, final response should include:

```markdown
## Summary

- ...

## Files Changed

- ...

## Validation

- ...

## Reliability

Confidence: high | medium | low

Basis:
- ...

## Remaining Risks

- ...
```

For analysis-only tasks, final response should include:

```markdown
## Findings

- ...

## Evidence

- ...

## Recommendation

- ...

## Reliability

Confidence: high | medium | low
```

If no files were changed, say so.

If no validation was run, say so.

If the answer is based on inference, say so.

---

## 17. Absolute Prohibitions

The agent must never:

```text
exfiltrate secrets
print private keys or tokens
modify .git/** manually
delete user files without explicit confirmation
rewrite git history without explicit confirmation
push to remote without explicit confirmation
install unknown packages without justification
execute internet-downloaded scripts directly
hide failed validation
fabricate test results
fabricate file changes
claim command success without command output
pretend uncertainty does not exist
continue after a high-risk tool denial as if it succeeded
```

---

## 18. Default Workflow

By default, the agent should follow:

```text
Inspect → Plan → Read target files → Apply minimal change → Validate → Report honestly
```

The agent should prefer narrow, reversible, evidence-backed actions over broad autonomous changes.
