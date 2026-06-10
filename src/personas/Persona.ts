/**
 * Persona — the static configuration of a single role in the orchestrator.
 *
 * A Persona binds a role identity to its model, system prompt, tool
 * allowlist/denylist, write-path policy, and output schema. Personas are
 * registered once at startup; the master_planner picks from this fixed set
 * when compiling the Task DAG.
 *
 * Hard rules:
 *  - There is exactly one `kind: 'master'` persona (master_planner).
 *  - Every worker Persona uses the shared `task_report` output schema so
 *    TaskRunner can reliably parse the common worker envelope.
 *  - Read-only Personas (vision, repo_scout, reviewer) have `canWrite: false`
 *    on `pathPolicy` — PathPolicyEnforcer denies all writes regardless of
 *    Task Contract.
 */

export type PersonaId =
	| "master_planner"
	| "vision"
	| "repo_scout"
	| "web_searcher"
	| "context_builder"
	| "code_executor"
	| "test_writer"
	| "test_runner"
	| "runtime_debug"
	| "reviewer"
	| "docs";

export type PersonaKind = "master" | "worker";

export type PersonaModel = "mimo-v2.5-pro" | "mimo-v2.5" | "mimo-omni";

export type OutputSchema =
	| "task_report"
	| "planner_dag"
	| "planner_finalize";

export interface PathPolicy {
	/** False for read-only personas (vision, repo_scout, reviewer). */
	canWrite: boolean;
	/** Globs the persona is always allowed to write (e.g. _staging/<own taskId>). */
	alwaysAllowedGlobs: string[];
	/** Globs the persona must never touch regardless of Task Contract. */
	forbiddenGlobs: string[];
}

export interface Parallelism {
	/** If true, only one task with this persona may run per scheduler batch. */
	soloPerWave: boolean;
	/** Hard cap on concurrent instances within a scheduler batch. */
	maxConcurrent: number;
}

export interface Persona {
	id: PersonaId;
	kind: PersonaKind;
	model: PersonaModel;
	/** System prompt loaded from prompts/<id>.md (resolved by PersonaRegistry). */
	systemPrompt: string;
	/** Whitelisted tools by name (e.g. "read_file", "edit_file"). */
	toolAllowlist: string[];
	/** Forbidden tools — wins over allowlist if intersection appears. */
	toolDenylist: string[];
	pathPolicy: PathPolicy;
	maxSteps: number;
	maxTokens: number;
	outputSchema: OutputSchema;
	/**
	 * XML sub-tags that MUST appear inside `<task_report>` for a *completed*
	 * report to count as structurally complete (e.g. repo_scout's
	 * `<workspace_state>` / `<file_list>`). Empty/undefined means only the
	 * shared envelope is enforced. TaskRunner validates these after parsing and
	 * issues one targeted re-emit naming the missing block(s); blocked/failed
	 * reports are exempt because they legitimately omit deliverables.
	 */
	requiredReportBlocks?: string[];
	parallelism: Parallelism;
}

/** Globs every persona is forbidden from writing — the absolute baseline. */
export const GLOBAL_FORBIDDEN_WRITES: string[] = [
	".env",
	".env.*",
	".git/**",
	"package-lock.json",
	"node_modules/**",
	".minimum/_archive/**",
];

/**
 * Globs forbidden to all WORKER personas (but allowed to master_planner).
 *
 * The .minimum canonical files are the master's sole writable surface — no
 * worker may touch them, regardless of what its Task Contract says. Workers
 * still emit memory candidates, but TaskRunner (not the worker's tools) is
 * the one that writes to `.minimum/_staging/`.
 */
export const WORKER_FORBIDDEN_WRITES: string[] = [
	...GLOBAL_FORBIDDEN_WRITES,
	".minimum/**",
];
