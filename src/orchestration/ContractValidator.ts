import type { Persona } from "../personas/Persona.js";
import { getPersona } from "../personas/PersonaRegistry.js";
import { matchGlob, normalizeRelPath } from "../tools/policy/PathPolicyEnforcer.js";
import { groupBy } from "../utils/collections.js";
import type { InterfaceContract, TaskContract } from "./TaskContract.js";

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
			validatePersonaCompatibility(contract, persona, errors);
			validatePathPolicy(contract, persona, errors);
		} catch {
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
		if (
			contract.inputs.staticCompileCommands !== undefined &&
			!Array.isArray(contract.inputs.staticCompileCommands)
		) {
			errors.push("inputs.staticCompileCommands must be an array when provided");
		}
	}

	if (!Array.isArray(contract.acceptance) || contract.acceptance.length === 0)
		errors.push("acceptance must be a non-empty array");

	if (contract.personaId) {
		try {
			const persona = getPersona(contract.personaId);
			if (persona.pathPolicy.canWrite) {
				if (!Array.isArray(contract.nonGoals) || contract.nonGoals.length === 0)
					errors.push("nonGoals must be a non-empty array for write-capable tasks");
				if (!contract.blockedCondition || contract.blockedCondition.trim().length < 8)
					errors.push("blockedCondition must be at least 8 characters for write-capable tasks");
			}
		} catch {
			// Unknown persona is already reported above.
		}
	}

	if (!Array.isArray(contract.dependsOn))
		errors.push("dependsOn must be an array (use [] for no deps)");

	if (!contract.outputSchema) errors.push("outputSchema is required");
	if (contract.postStaticCompile) {
		if (typeof contract.postStaticCompile.required !== "boolean") {
			errors.push("postStaticCompile.required must be boolean");
		}
		if (!Array.isArray(contract.postStaticCompile.commands)) {
			errors.push("postStaticCompile.commands must be an array");
		}
	}

	return { ok: errors.length === 0, errors };
}

function validatePersonaCompatibility(
	contract: TaskContract,
	persona: Persona,
	errors: string[],
): void {
	if (contract.outputSchema && contract.outputSchema !== persona.outputSchema) {
		errors.push(
			`outputSchema ${contract.outputSchema} does not match persona ${persona.id} (expects ${persona.outputSchema})`,
		);
	}
}

function validatePathPolicy(
	contract: TaskContract,
	persona: Persona,
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

	// Read-only personas should not have any contract-level allowed globs;
	// PathPolicyEnforcer will deny writes regardless, but flagging here keeps
	// the master honest.
	if (!persona.pathPolicy.canWrite && allowedGlobs.length > 0) {
		errors.push(
			`persona ${persona.id} is read-only; allowedGlobs must be empty`,
		);
	}

	// Write-capable personas without their own always-allowed globs MUST get
	// scoped paths from the contract (e.g. code_executor). Personas that carry
	// their own alwaysAllowedGlobs (test_writer, docs, context_builder) are
	// already covered and need no contract globs — derived, not hardcoded.
	if (
		persona.pathPolicy.canWrite &&
		persona.pathPolicy.alwaysAllowedGlobs.length === 0 &&
		allowedGlobs.length === 0
	) {
		errors.push(
			`persona ${persona.id} requires allowedGlobs from the contract`,
		);
	}

	// Guardrail: an implementation persona scoped to Markdown-only output is a
	// mis-assignment. An analysis / audit / report task that only writes a
	// Markdown file belongs to `reviewer` (findings) + `docs` (report), not
	// `code_executor` — which is built for source edits and would otherwise be
	// wrongly gated on a whole-project static compile it cannot influence.
	if (
		persona.orchestration.chainRole === "implement" &&
		allowedGlobs.length > 0 &&
		allowedGlobs.every(isDocumentationGlob)
	) {
		errors.push(
			`${persona.id} task ${contract.taskId} writes only Markdown (${allowedGlobs.join(", ")}); ` +
				"analysis/report tasks belong to reviewer (findings) + docs (report) — reassign the persona",
		);
	}
}

const DOCUMENTATION_GLOB_RE = /\.(?:mdx?|markdown)$/i;

/** Whether a write glob targets only a documentation (Markdown) file. */
function isDocumentationGlob(glob: string): boolean {
	return DOCUMENTATION_GLOB_RE.test(glob.replace(/\\/g, "/").trim());
}

/**
 * Check disjointness of allowedGlobs across tasks in the same parallelGroup.
 * Returns a list of conflicts {taskA, taskB, glob} — empty if clean.
 */
export function findGlobConflicts(
	contracts: TaskContract[],
): Array<{ taskA: string; taskB: string; glob: string }> {
	const conflicts: Array<{ taskA: string; taskB: string; glob: string }> = [];
	const byGroup = groupBy(contracts, (c) => c.parallelGroup);

	for (const group of byGroup.values()) {
		// Precompute one glob Set per task so each task's globs are hashed once.
		const sets = group.map((g) => new Set(g.pathPolicy.allowedGlobs));
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				const a = group[i]!;
				const b = group[j]!;
				for (const glob of sets[i]!) {
					if (sets[j]!.has(glob)) {
						conflicts.push({ taskA: a.taskId, taskB: b.taskId, glob });
					}
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

/**
 * Validate module interface contracts across a contract set. A contract is
 * denormalized onto owner + consumers (same object on several tasks), so we
 * dedupe by id first. Returns a flat error list, empty if clean.
 *
 * Checks, all deterministic and AST-free:
 *  - ownerTaskId and consumerTaskIds resolve to tasks in the set;
 *  - owner's allowedGlobs cover every binding file (owner can write them);
 *  - no consumer's allowedGlobs matches any binding file (signature immutable);
 *  - every consumer (transitively) depends on the owner.
 */
export function findInterfaceContractIssues(contracts: TaskContract[]): string[] {
	const errors: string[] = [];
	const byId = new Map(contracts.map((c) => [c.taskId, c]));
	const reaches = buildReachability(contracts);

	const uniq = new Map<string, InterfaceContract>();
	for (const c of contracts) {
		for (const ic of c.interfaceContracts ?? []) {
			if (!uniq.has(ic.id)) uniq.set(ic.id, ic);
		}
	}

	for (const ic of uniq.values()) {
		const owner = byId.get(ic.ownerTaskId);
		if (!owner) {
			errors.push(`interface ${ic.id}: ownerTaskId ${ic.ownerTaskId} is not a task in this set`);
		}
		const bindingFiles = ic.bindings.flatMap((b) => b.files.map((f) => normalizeRelPath(f)));

		if (owner) {
			for (const file of bindingFiles) {
				if (!owner.pathPolicy.allowedGlobs.some((g) => matchGlob(file, g))) {
					errors.push(`interface ${ic.id}: owner ${owner.taskId} allowedGlobs must cover binding file ${file}`);
				}
			}
		}

		for (const consumerId of ic.consumerTaskIds) {
			const consumer = byId.get(consumerId);
			if (!consumer) {
				errors.push(`interface ${ic.id}: consumerTaskId ${consumerId} is not a task in this set`);
				continue;
			}
			for (const file of bindingFiles) {
				if (consumer.pathPolicy.allowedGlobs.some((g) => matchGlob(file, g))) {
					errors.push(`interface ${ic.id}: consumer ${consumerId} must not be able to write binding file ${file}`);
				}
			}
			if (owner && consumerId !== owner.taskId && !reaches(consumerId, owner.taskId)) {
				errors.push(`interface ${ic.id}: consumer ${consumerId} must depend (transitively) on owner ${owner.taskId}`);
			}
		}
	}
	return errors;
}

/**
 * Returns a predicate reaches(from, to): does `from` depend transitively on `to`?
 * Assumes an acyclic dependency graph; the memo guards against infinite recursion
 * on a malformed cyclic DAG but a cyclic node will report incomplete ancestors.
 * Callers (refineDag, buildTaskBatches) reject cycles separately (Kahn's sort).
 */
function buildReachability(contracts: TaskContract[]): (from: string, to: string) => boolean {
	const deps = new Map(contracts.map((c) => [c.taskId, c.dependsOn]));
	const memo = new Map<string, Set<string>>();
	function ancestorsOf(id: string): Set<string> {
		const cached = memo.get(id);
		if (cached) return cached;
		const acc = new Set<string>();
		memo.set(id, acc); // guard against cycles
		for (const dep of deps.get(id) ?? []) {
			acc.add(dep);
			for (const a of ancestorsOf(dep)) acc.add(a);
		}
		return acc;
	}
	return (from, to) => ancestorsOf(from).has(to);
}

/** Re-exported for discoverability — grant validation is catalog-aware (see CapabilityCatalog). */
export { validateGrants } from "./CapabilityCatalog.js";
