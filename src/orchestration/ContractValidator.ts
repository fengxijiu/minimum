import { getPersona } from "../personas/PersonaRegistry.js";
import type { TaskContract } from "./TaskContract.js";

/**
 * ContractValidator — runtime check that gates worker launch.
 *
 * Why hand-rolled instead of zod: the contract has ~10 fields with simple
 * shape; bringing in a runtime dep for this is not worth it. The validator
 * emits a flat list of error messages so the caller can attach them all to
 * the BLOCKED_INVALID_CONTRACT report instead of failing fast on the first
 * problem (faster feedback loop for the master).
 */

export interface ValidationResult {
	ok: boolean;
	errors: string[];
}

const TASK_ID_RE = /^T(?:[-_])?[A-Za-z0-9_.-]+$/;
const PERSONA_PERMITS_WRITE_NO_CONTRACT_GLOBS = new Set([
	// These personas have alwaysAllowedGlobs that cover their own paths;
	// they can run without contract-level allowedGlobs.
	"context_builder",
	"test_writer",
	"docs",
]);

/** Validate a fully-formed contract. Returns the collected error list. */
export function validateContract(contract: TaskContract): ValidationResult {
	const errors: string[] = [];

	if (!contract.taskId) errors.push("taskId is required");
	else if (!TASK_ID_RE.test(contract.taskId))
		errors.push(
			`taskId ${JSON.stringify(contract.taskId)} must match ${TASK_ID_RE}`,
		);

	if (!contract.epicId) errors.push("epicId is required");
	if (!contract.phase) errors.push("phase is required");
	if (!contract.parallelGroup) errors.push("parallelGroup is required");
	if (!contract.objective || contract.objective.trim().length < 8)
		errors.push("objective must be at least 8 characters");

	if (!contract.personaId) errors.push("personaId is required");
	else {
		try {
			const persona = getPersona(contract.personaId);
			validatePersonaCompatibility(contract, persona.id, errors);
			validatePathPolicy(contract, persona.id, errors);
		} catch (e) {
			errors.push(`unknown personaId: ${contract.personaId}`);
		}
	}

	if (!contract.inputs) errors.push("inputs is required");
	else {
		if (!contract.inputs.userGoal || contract.inputs.userGoal.trim().length < 4)
			errors.push("inputs.userGoal must be at least 4 characters");
		if (!Array.isArray(contract.inputs.artifacts))
			errors.push("inputs.artifacts must be an array");
		if (!Array.isArray(contract.inputs.constraints))
			errors.push("inputs.constraints must be an array");
	}

	if (!Array.isArray(contract.acceptance) || contract.acceptance.length === 0)
		errors.push("acceptance must be a non-empty array");

	if (!Array.isArray(contract.dependsOn))
		errors.push("dependsOn must be an array (use [] for no deps)");

	if (!contract.outputSchema) errors.push("outputSchema is required");

	return { ok: errors.length === 0, errors };
}

function validatePersonaCompatibility(
	contract: TaskContract,
	personaId: string,
	errors: string[],
): void {
	const persona = getPersona(contract.personaId);
	if (contract.outputSchema && contract.outputSchema !== persona.outputSchema) {
		errors.push(
			`outputSchema ${contract.outputSchema} does not match persona ${personaId} (expects ${persona.outputSchema})`,
		);
	}
}

function validatePathPolicy(
	contract: TaskContract,
	personaId: string,
	errors: string[],
): void {
	if (!contract.pathPolicy) {
		errors.push("pathPolicy is required");
		return;
	}
	const { allowedGlobs, forbiddenGlobs } = contract.pathPolicy;
	if (!Array.isArray(allowedGlobs)) {
		errors.push("pathPolicy.allowedGlobs must be an array");
		return;
	}
	if (!Array.isArray(forbiddenGlobs))
		errors.push("pathPolicy.forbiddenGlobs must be an array");

	const persona = getPersona(contract.personaId);

	// Read-only personas should not have any contract-level allowed globs;
	// PathPolicyEnforcer will deny writes regardless, but flagging here keeps
	// the master honest.
	if (!persona.pathPolicy.canWrite && allowedGlobs.length > 0) {
		errors.push(
			`persona ${personaId} is read-only; allowedGlobs must be empty`,
		);
	}

	// Write-capable personas without their own always-allowed globs MUST get
	// scoped paths from the contract (e.g. code_executor).
	if (
		persona.pathPolicy.canWrite &&
		persona.pathPolicy.alwaysAllowedGlobs.length === 0 &&
		allowedGlobs.length === 0 &&
		!PERSONA_PERMITS_WRITE_NO_CONTRACT_GLOBS.has(personaId)
	) {
		errors.push(
			`persona ${personaId} requires allowedGlobs from the contract`,
		);
	}
}

/**
 * Check disjointness of allowedGlobs across tasks in the same parallelGroup.
 * Returns a list of conflicts {taskA, taskB, glob} — empty if clean.
 */
export function findGlobConflicts(
	contracts: TaskContract[],
): Array<{ taskA: string; taskB: string; glob: string }> {
	const conflicts: Array<{ taskA: string; taskB: string; glob: string }> = [];
	const byGroup = new Map<string, TaskContract[]>();
	for (const c of contracts) {
		const list = byGroup.get(c.parallelGroup) ?? [];
		list.push(c);
		byGroup.set(c.parallelGroup, list);
	}

	for (const group of byGroup.values()) {
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				const a = group[i]!;
				const b = group[j]!;
				const shared = a.pathPolicy.allowedGlobs.filter((g) =>
					b.pathPolicy.allowedGlobs.includes(g),
				);
				for (const glob of shared) {
					conflicts.push({ taskA: a.taskId, taskB: b.taskId, glob });
				}
			}
		}
	}

	return conflicts;
}

/** Verify all dependsOn refer to existing task ids within the same set. */
export function findDanglingDeps(
	contracts: TaskContract[],
): Array<{ taskId: string; missingDep: string }> {
	const ids = new Set(contracts.map((c) => c.taskId));
	const out: Array<{ taskId: string; missingDep: string }> = [];
	for (const c of contracts) {
		for (const dep of c.dependsOn) {
			if (!ids.has(dep))
				out.push({ taskId: c.taskId, missingDep: dep });
		}
	}
	return out;
}
