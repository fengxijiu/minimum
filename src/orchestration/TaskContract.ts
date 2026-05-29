import type { OutputSchema, PersonaId } from "../personas/Persona.js";

/**
 * TaskContract — the binding agreement between master_planner and a worker.
 *
 * Every Task in the DAG must have a fully-populated TaskContract before
 * WaveScheduler launches its worker. ContractValidator enforces this at
 * the entry to TaskRunner; missing required fields cause the launch to
 * fail with BLOCKED_INVALID_CONTRACT and force the master to re-compile.
 */
export interface TaskContract {
	/** Globally unique within the epic; e.g. "T-C1-2". */
	taskId: string;
	/** Phase id this task belongs to; e.g. "P3-frontend". */
	phase: string;
	/** Epic id this task belongs to; e.g. "image_upload". */
	epicId: string;
	/** Which persona executes this task. */
	personaId: PersonaId;
	/** Human-readable objective shown to the worker. */
	objective: string;

	inputs: TaskInputs;
	pathPolicy: TaskPathPolicy;
	acceptance: string[];

	/** Output schema expected from the worker; mirrors persona.outputSchema. */
	outputSchema: OutputSchema;

	/**
	 * Tasks sharing a parallelGroup run concurrently in the same Wave.
	 * ContractValidator + TaskGraph guarantee disjoint allowedGlobs within
	 * a group so two writers never touch the same file.
	 */
	parallelGroup: string;

	/** Upstream task ids that must complete before this task starts. */
	dependsOn: string[];

	/** If true, a path violation aborts the task instead of denying the call. */
	abortOnConflict: boolean;
}

export interface TaskInputs {
	/** The original user goal (passed verbatim, for grounding). */
	userGoal: string;
	/** Path to the ContextPack markdown built by context_builder; optional in W1. */
	contextPack?: string;
	/** Paths to upstream artifacts (vision json, scout json, etc.). */
	artifacts: string[];
	/** Constraint statements the worker must honor. */
	constraints: string[];
}

export interface TaskPathPolicy {
	/**
	 * Globs the worker may write to within this task. Empty array means the
	 * worker cannot write any business files — only its staging memory file
	 * gets through (handled by PathPolicyEnforcer in P4).
	 */
	allowedGlobs: string[];
	/** Globs the worker must never touch (merged with persona's globals). */
	forbiddenGlobs: string[];
}

/** Master's coarse DAG output before any contract validation. */
export interface CoarseTask {
	id: string;
	personaId: PersonaId;
	objective: string;
	parallelGroup: string;
	dependsOn: string[];
	needsRefine: boolean;
	/** Populated only when needsRefine is false at coarse-compile time. */
	allowedGlobs?: string[];
}

export interface CoarsePhase {
	id: string;
	name: string;
	tasks: CoarseTask[];
}

export interface CoarseDag {
	epicId: string;
	phases: CoarsePhase[];
}
