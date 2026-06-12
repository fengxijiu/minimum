import type { OutputSchema, PersonaId } from "../personas/Persona.js";

export type LaunchArtifact =
	| "file_list"
	| "relevant_files"
	| "tech_stack"
	| "test_commands"
	| "static_compile_commands"
	| "visual_summary";

export interface LaunchRequirement {
	sourceTaskId: string;
	artifact: LaunchArtifact;
	required: boolean;
	fallback?: LaunchRequirementFallback;
}

export interface LaunchRequirementFallback {
	mode: "readonly_workspace";
	allowedWhen: string[];
}

/**
 * TaskContract — the binding agreement between master_planner and a worker.
 *
 * Every Task in the DAG must have a fully-populated TaskContract before
 * the harness launches its worker. ContractValidator enforces this at
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
	/** Explicit out-of-scope boundaries; required for write-capable tasks. */
	nonGoals?: string[];
	/** Concrete condition that should stop the task and trigger changed repair context. */
	blockedCondition?: string;
	/** Structured W0.5 launch gate evidence required before scheduling. */
	launchRequirements?: LaunchRequirement[];
	/** Tail static-compile enforcement for this task, when required. */
	postStaticCompile?: {
		required: boolean;
		commands: string[];
	};
	/**
	 * When true, the worker must first emit an <execution_plan> that
	 * master_planner audits (W2-plan gate) before it may write/execute. Defaults
	 * on for code_executor / test_writer write tasks when planMode is enabled.
	 */
	requiresPlanApproval?: boolean;

	/** Output schema expected from the worker; worker personas use task_report. */
	outputSchema: OutputSchema;

	/**
	 * Tasks sharing a parallelGroup run concurrently in the same scheduler batch.
	 * ContractValidator + TaskGraph guarantee disjoint allowedGlobs within
	 * a group so two writers never touch the same file.
	 */
	parallelGroup: string;

	/** Upstream task ids that must complete before this task starts. */
	dependsOn: string[];

	/** Scheduling priority hint (P0 highest … P3 lowest); defaults to P2 when absent. */
	priority?: "P0" | "P1" | "P2" | "P3";

	/** Skills the master granted this task on top of the persona's defaults. */
	grantedSkills: string[];
	/** MCP tool names (mcp__server__tool) the master granted this task. */
	grantedMcpTools: string[];

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
	/** Project-level static compile commands selected for this run. */
	staticCompileCommands?: string[];
	/**
	 * The execution plan approved (and possibly corrected) by master_planner in
	 * the W2-plan gate. Injected into the execute run so the worker stays within
	 * the audited scope. Absent when planMode is off or the task needs no plan.
	 */
	approvedPlan?: string;
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
	/** W3.5 loop-back metadata, preserved for repair DAG refinement. */
	acceptance?: string[];
	priority?: string;
	sourceIssue?: string;
	blocking?: boolean;
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
