import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	GLOBAL_FORBIDDEN_WRITES,
	WORKER_FORBIDDEN_WRITES,
	type Persona,
	type PersonaId,
	type PersonaOrchestration,
	type PersonaRouteRole,
	type PersonaStage,
	type PersonaTaskCap,
} from "./Persona.js";
import { renderInlineSkillsForPersona, renderInlineSkillsForPersonaStage } from "./SkillRegistry.js";

const PROMPTS_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"prompts",
);

function loadPrompt(file: string): string {
	return fs.readFileSync(path.join(PROMPTS_DIR, file), "utf-8");
}

export function loadBaseRules(): string {
	return loadPrompt("_base-rules.md");
}

/**
 * Build the system prompt for a worker: role-specific text + the shared
 * output protocol footer. Master prompts skip the footer because their
 * output schema (planner_dag / planner_finalize) is different.
 */
function buildWorkerPrompt(roleFile: string, footer: string): string {
	const role = loadPrompt(roleFile);
	return role.trimEnd() + "\n\n" + footer.trimStart();
}

function buildPersonaPrompt(
	personaId: PersonaId,
	roleFile: string,
	footer: string,
): string {
	const role = loadPrompt(roleFile);
	const skills = renderInlineSkillsForPersona(personaId);
	const parts = [role.trimEnd()];
	if (skills) parts.push(skills);
	parts.push(footer.trimStart());
	return parts.join("\n\n");
}

function buildMasterPrompt(personas?: Iterable<Persona>): string {
	return buildMasterStagePrompt("full", personas);
}

export type MasterPlannerStage = "full" | "W0" | "W0.5" | "W2-plan" | "W4";

const MASTER_PROMPT_PARTS = {
	intro: "master-planner/_intro.md",
	shared: "master-planner/shared.md",
	w0: "master-planner/w0.md",
	w05: "master-planner/w05.md",
	w4Finalize: "master-planner/w4-finalize.md",
	w4Delivery: "master-planner/w4-delivery.md",
	w2Plan: "master-planner/w2-plan.md",
} as const;

const MASTER_STAGE_PARTS: Record<MasterPlannerStage, readonly string[]> = {
	full: [
		MASTER_PROMPT_PARTS.intro,
		MASTER_PROMPT_PARTS.shared,
		MASTER_PROMPT_PARTS.w0,
		MASTER_PROMPT_PARTS.w05,
		MASTER_PROMPT_PARTS.w4Finalize,
		MASTER_PROMPT_PARTS.w4Delivery,
		MASTER_PROMPT_PARTS.w2Plan,
	],
	"W0": [
		MASTER_PROMPT_PARTS.intro,
		MASTER_PROMPT_PARTS.shared,
		MASTER_PROMPT_PARTS.w0,
	],
	"W0.5": [
		MASTER_PROMPT_PARTS.intro,
		MASTER_PROMPT_PARTS.shared,
		MASTER_PROMPT_PARTS.w05,
	],
	"W2-plan": [
		MASTER_PROMPT_PARTS.intro,
		MASTER_PROMPT_PARTS.shared,
		MASTER_PROMPT_PARTS.w2Plan,
	],
	"W4": [
		MASTER_PROMPT_PARTS.intro,
		MASTER_PROMPT_PARTS.shared,
		MASTER_PROMPT_PARTS.w4Finalize,
	],
};

export function buildMasterStagePrompt(stage: MasterPlannerStage, personas?: Iterable<Persona>): string {
	const catalog = stage === "W0" || stage === "W0.5" || stage === "full"
		? buildPersonaCatalogBlock(personas)
		: "";
	const skills = stage === "full"
		? renderInlineSkillsForPersona("master_planner")
		: renderInlineSkillsForPersonaStage("master_planner", stage);
	const parts = MASTER_STAGE_PARTS[stage].map((file) => loadPrompt(file).trim());
	if (catalog) parts.push(catalog);
	if (skills) parts.push(skills);
	return parts.join("\n\n");
}

function buildPersonaCatalogBlock(personas?: Iterable<Persona>): string {
	const source = personas ? Array.from(personas) : (REGISTRY ? listPersonas() : []);
	const ids = source.map((p) => p.id);
	const lines = source
		.map((p) => {
			const o = p.orchestration;
			return [
				`- ${p.id}`,
				`  stage: ${o.stage}`,
				`  chainRole: ${o.chainRole}`,
				`  routeRoles: ${o.routeRoles.join(", ") || "(explicit only)"}`,
				`  write: ${p.pathPolicy.canWrite ? "yes" : "no"}`,
				`  producesArtifacts: ${o.producesArtifacts.join(", ") || "(none)"}`,
				`  maxConcurrent: ${p.parallelism.maxConcurrent}`,
			].join("\n");
		})
		.join("\n");
	return [
		"## Persona Catalog",
		"",
		"Use EXACTLY one of these strings (lowercase, underscore-separated) for any",
		"`persona` field in <task_dag> or <refine>:",
		"",
		ids.map((i) => `- ${i}`).join("\n"),
		"",
		"Use the metadata below to place each persona in the DAG chain. Personas with",
		"no matching routeRoles should only be used when the user explicitly asks for",
		"that specialty or no existing persona can safely own the work.",
		"",
		lines,
		"",
		"Prefer the exact ids above. Do NOT invent undeclared synonyms or unknown",
		"roles. `mission_checker` is a W3.5 inline role and MUST NOT appear as a",
		"coarse DAG persona. Any other value is rejected by the compiler and aborts",
		"the run.",
	].join("\n");
}

function orchestration(input: PersonaOrchestration): PersonaOrchestration {
	return input;
}

/**
 * Construct the canonical set of 10 personas. Called once at module load.
 *
 * Persona definitions are intentionally static — master_planner picks from
 * this fixed roster. Adding a new role requires a code change so its tool
 * allowlist and path policy are reviewed.
 */
function buildPersonas(): Map<PersonaId, Persona> {
	const footer = loadPrompt("_common-footer.md");

	const out = new Map<PersonaId, Persona>();

	out.set("master_planner", {
		id: "master_planner",
		kind: "master",
		model: "mimo-v2.5-pro",
		systemPrompt: "",
		toolAllowlist: ["*", "read_file", "ask_choice"],
		toolDenylist: ["exec_shell"],
		pathPolicy: {
			canWrite: true,
			alwaysAllowedGlobs: ["**"],
			forbiddenGlobs: GLOBAL_FORBIDDEN_WRITES,
		},
		maxSteps: 200,
		maxTokens: 131_072,
		outputSchema: "planner_dag",
		parallelism: { soloPerWave: true, maxConcurrent: 1 },
		orchestration: orchestration({
			stage: "support",
			routeRoles: [],
			chainRole: "design",
			executionDepth: "normal",
			planGate: "never",
			producesArtifacts: [],
			repairAliases: ["master", "planner", "master_planner"],
		}),
	});

	out.set("vision", {
		id: "vision",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildPersonaPrompt("vision", "vision.md", footer),
		toolAllowlist: [
			"read_file",
			"list_directory",
			"shell_fs_read",
			"shell_search",
			"shell_git_read",
			"shell_env_probe",
		],
		toolDenylist: [
			"write_file", "edit_file", "apply_patch",
			"exec_shell",
			"shell_test", "shell_typecheck", "shell_lint", "shell_build", "shell_raw",
			"install_dependency", "run_background", "stop_job",
		],
		pathPolicy: {
			canWrite: false,
			alwaysAllowedGlobs: [],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 100,
		maxTokens: 64_000,
		outputSchema: "task_report",
		// vision.md core deliverable + the named W0.5 launch artifact.
		requiredReportBlocks: ["visual_summary"],
		parallelism: { soloPerWave: false, maxConcurrent: 1 },
		orchestration: orchestration({
			stage: "perception",
			routeRoles: ["full_pipeline"],
			chainRole: "discover",
			executionDepth: "fast",
			planGate: "never",
			producesArtifacts: ["visual_summary"],
			repairAliases: ["vision", "visual", "screenshot", "design_mock"],
		}),
	});

	out.set("repo_scout", {
		id: "repo_scout",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildPersonaPrompt("repo_scout", "repo-scout.md", footer),
		toolAllowlist: [
			"read_file",
			"list_directory",
			"grep",
			"glob",
			"git_status",
			"git_log",
		],
		toolDenylist: ["write_file", "edit_file", "apply_patch", "exec_shell"],
		pathPolicy: {
			canWrite: false,
			alwaysAllowedGlobs: [],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 100,
		maxTokens: 64_000,
		outputSchema: "task_report",
		// repo-scout.md mandates these blocks ("Always output <workspace_state>,
		// <task_semantics>, and <pipeline_directive>" + a non-omittable
		// <file_list>). TaskRunner re-prompts for any that are missing.
		requiredReportBlocks: ["workspace_state", "task_semantics", "file_list", "pipeline_directive"],
		parallelism: { soloPerWave: false, maxConcurrent: 3 },
		orchestration: orchestration({
			stage: "perception",
			routeRoles: ["scan_only", "direct_edit", "audit_review", "implementation", "dependency_config", "full_pipeline"],
			chainRole: "discover",
			defaultTaskCap: {
				scan_only: { min: 1, max: 1 },
				direct_edit: { min: 1, max: 1 },
				audit_review: { min: 1, max: 4 },
				implementation: { min: 1, max: 4 },
				dependency_config: { min: 1, max: 2 },
			},
			executionDepth: "normal",
			planGate: "never",
			producesArtifacts: ["file_list", "relevant_files", "tech_stack", "test_commands", "static_compile_commands"],
			repairAliases: ["repo", "scout", "repo_scout", "discovery", "repository"],
		}),
	});

	out.set("web_searcher", {
		id: "web_searcher",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildPersonaPrompt("web_searcher", "web-searcher.md", footer),
		// web_fetch reads pages; mcp__* covers the user's web-search MCP server
		// (e.g. OneSearch) whose exact tool names are config-dependent. Read-only,
		// so the broad MCP wildcard cannot write or execute anything.
		toolAllowlist: ["web_fetch", "read_file", "mcp__*"],
		toolDenylist: ["write_file", "edit_file", "apply_patch", "exec_shell"],
		pathPolicy: {
			canWrite: false,
			alwaysAllowedGlobs: [],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 100,
		maxTokens: 64_000,
		outputSchema: "task_report",
		parallelism: { soloPerWave: false, maxConcurrent: 2 },
		orchestration: orchestration({
			stage: "perception",
			routeRoles: ["debug_fix", "dependency_config", "full_pipeline"],
			chainRole: "discover",
			executionDepth: "fast",
			planGate: "never",
			producesArtifacts: ["relevant_files"],
			repairAliases: ["web", "search", "web_searcher", "external_docs"],
		}),
	});

	out.set("context_builder", {
		id: "context_builder",
		kind: "worker",
		model: "mimo-v2.5-pro",
		systemPrompt: buildPersonaPrompt("context_builder", "context-builder.md", footer),
		toolAllowlist: ["read_file", "list_directory", "write_file"],
		toolDenylist: ["edit_file", "apply_patch", "exec_shell"],
		pathPolicy: {
			canWrite: true,
			// Only allowed to write under per-epic context-packs dir; the actual
			// taskId-scoped path is locked in by the Task Contract.
			alwaysAllowedGlobs: ["tasks/**/context-packs/**"],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 100,
		maxTokens: 131_072,
		outputSchema: "task_report",
		parallelism: { soloPerWave: false, maxConcurrent: 2 },
		orchestration: orchestration({
			stage: "perception",
			routeRoles: ["implementation", "audit_review", "full_pipeline"],
			chainRole: "design",
			executionDepth: "fast",
			planGate: "all_writes",
			producesArtifacts: ["relevant_files"],
			repairAliases: ["context", "context_builder", "context_pack"],
		}),
	});

	out.set("code_executor", {
		id: "code_executor",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildPersonaPrompt("code_executor", "code-executor.md", footer),
		toolAllowlist: ["*", "read_file"],
		toolDenylist: ["exec_shell"],
		pathPolicy: {
			canWrite: true,
			alwaysAllowedGlobs: [],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 100,
		maxTokens: 64_000,
		outputSchema: "task_report",
		// code-executor.md mandates a one-sentence <summary> and the deliverable
		// <changed_files> list for a completed implementation.
		requiredReportBlocks: ["summary", "changed_files"],
		parallelism: { soloPerWave: false, maxConcurrent: 2 },
		orchestration: orchestration({
			stage: "implementation",
			routeRoles: ["direct_edit", "implementation", "debug_fix", "dependency_config", "full_pipeline"],
			chainRole: "implement",
			defaultTaskCap: {
				direct_edit: { min: 1, max: 1 },
				implementation: { min: 1, max: 6 },
				debug_fix: { min: 1, max: 3 },
				dependency_config: { min: 1, max: 3 },
			},
			executionDepth: "normal",
			planGate: "code_personas",
			producesArtifacts: [],
			repairAliases: ["coder", "code", "developer", "implementation", "implementer", "code_executor"],
		}),
	});

	out.set("test_writer", {
		id: "test_writer",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildPersonaPrompt("test_writer", "test-writer.md", footer),
		toolAllowlist: [
			"read_file",
			"list_directory",
			"grep",
			"glob",
			"write_file",
			"edit_file",
			"apply_patch",
		],
		toolDenylist: ["exec_shell"],
		pathPolicy: {
			canWrite: true,
			alwaysAllowedGlobs: [
				"tests/**",
				"**/*.test.ts",
				"**/*.test.tsx",
				"**/*.spec.ts",
				"**/*.spec.tsx",
				"**/test_*.py",
				"**/*_test.go",
			],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 100,
		maxTokens: 48_000,
		outputSchema: "task_report",
		// test-writer.md core deliverables: the covered surface and the test files.
		requiredReportBlocks: ["test_scope", "new_or_modified_tests"],
		parallelism: { soloPerWave: false, maxConcurrent: 2 },
		orchestration: orchestration({
			stage: "implementation",
			routeRoles: ["implementation", "full_pipeline"],
			chainRole: "test_author",
			defaultTaskCap: {
				implementation: { min: 1, max: 6 },
			},
			executionDepth: "normal",
			planGate: "code_personas",
			producesArtifacts: [],
			repairAliases: ["tester", "tests", "test", "test_writer", "test_author"],
		}),
	});

	out.set("test_runner", {
		id: "test_runner",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildPersonaPrompt("test_runner", "test-runner.md", footer),
		toolAllowlist: [
			"read_file",
			"exec_shell",
			"shell_fs_read",
			"shell_search",
			"shell_git_read",
			"shell_env_probe",
			"shell_test",
			"shell_typecheck",
			"shell_lint",
			"shell_build",
		],
		toolDenylist: ["write_file", "edit_file", "apply_patch"],
		pathPolicy: {
			canWrite: false,
			alwaysAllowedGlobs: [],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 100,
		maxTokens: 64_000,
		outputSchema: "task_report",
		// test-runner.md: every run reports the command it ran and its exit code.
		requiredReportBlocks: ["command", "exit_code"],
		parallelism: { soloPerWave: false, maxConcurrent: 3 },
		orchestration: orchestration({
			stage: "validation",
			routeRoles: ["direct_edit", "implementation", "debug_fix", "dependency_config", "full_pipeline"],
			chainRole: "validate",
			defaultTaskCap: {
				direct_edit: { min: 0, max: 1 },
				implementation: { min: 1, max: 4 },
				debug_fix: { min: 1, max: 3 },
				dependency_config: { min: 1, max: 3 },
			},
			executionDepth: "fast",
			planGate: "never",
			producesArtifacts: ["test_commands", "static_compile_commands"],
			repairAliases: ["runner", "test_runner", "validation", "validate"],
		}),
	});

	out.set("runtime_debug", {
		id: "runtime_debug",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildPersonaPrompt("runtime_debug", "runtime-debug.md", footer),
		toolAllowlist: [
			"read_file",
			"list_directory",
			"grep",
			"glob",
			"git_status",
			"git_log",
			"write_file",
			"install_dependency",
		],
		toolDenylist: ["edit_file", "apply_patch", "exec_shell"],
		pathPolicy: {
			canWrite: true,
			alwaysAllowedGlobs: ["tasks/**/artifacts/**"],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 100,
		maxTokens: 64_000,
		outputSchema: "task_report",
		// runtime-debug.md exists to produce a <root_cause>; a completed diagnosis
		// must carry one (an undetermined cause returns blocked, which is exempt).
		requiredReportBlocks: ["root_cause"],
		parallelism: { soloPerWave: true, maxConcurrent: 1 },
		orchestration: orchestration({
			stage: "diagnosis",
			routeRoles: ["debug_fix", "full_pipeline"],
			chainRole: "debug",
			defaultTaskCap: {
				debug_fix: { min: 1, max: 2 },
			},
			executionDepth: "deep",
			planGate: "all_writes",
			producesArtifacts: ["relevant_files"],
			repairAliases: ["debug", "diagnosis", "runtime_debug", "root_cause"],
		}),
	});

	out.set("reviewer", {
		id: "reviewer",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildPersonaPrompt("reviewer", "reviewer.md", footer),
		toolAllowlist: ["read_file", "grep", "glob", "git_diff"],
		toolDenylist: ["write_file", "edit_file", "apply_patch", "exec_shell"],
		pathPolicy: {
			canWrite: false,
			alwaysAllowedGlobs: [],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 100,
		maxTokens: 48_000,
		outputSchema: "task_report",
		// reviewer.md: the verdict and risk level are mandatory single-line fields.
		requiredReportBlocks: ["decision", "risk_level"],
		parallelism: { soloPerWave: false, maxConcurrent: 2 },
		orchestration: orchestration({
			stage: "review",
			routeRoles: ["audit_review", "implementation", "debug_fix", "dependency_config", "full_pipeline"],
			chainRole: "review",
			defaultTaskCap: {
				audit_review: { min: 2, max: 10 },
				implementation: { min: 0, max: 2 },
				debug_fix: { min: 0, max: 2 },
				dependency_config: { min: 0, max: 1 },
			},
			executionDepth: "fast",
			planGate: "never",
			producesArtifacts: [],
			repairAliases: ["review", "reviewer", "audit", "critic"],
		}),
	});

	out.set("docs", {
		id: "docs",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildPersonaPrompt("docs", "docs.md", footer),
		toolAllowlist: [
			"read_file",
			"list_directory",
			"grep",
			"glob",
			"write_file",
			"edit_file",
			"apply_patch",
		],
		toolDenylist: ["exec_shell"],
		pathPolicy: {
			canWrite: true,
			alwaysAllowedGlobs: [
				"README.md",
				"docs/**",
				"CHANGELOG.md",
			],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 100,	
		maxTokens: 64_000,
		outputSchema: "task_report",
		// docs.md: a completed docs task always summarizes the user-facing outcome
		// (even "no doc changes needed"); <changed_docs>/<patch> stay conditional.
		requiredReportBlocks: ["summary"],
		parallelism: { soloPerWave: false, maxConcurrent: 2 },
		orchestration: orchestration({
			stage: "delivery",
			routeRoles: ["audit_review", "implementation", "full_pipeline"],
			chainRole: "document",
			defaultTaskCap: {
				audit_review: { min: 1, max: 1 },
				implementation: { min: 0, max: 1 },
			},
			executionDepth: "fast",
			planGate: "all_writes",
			producesArtifacts: [],
			repairAliases: ["documentation", "doc", "docs", "deliver", "delivery"],
		}),
	});

	refreshMasterPrompt(out);

	return out;
}

let REGISTRY: Map<PersonaId, Persona> | undefined = buildPersonas();

function registry(): Map<PersonaId, Persona> {
	if (!REGISTRY) REGISTRY = buildPersonas();
	return REGISTRY;
}

/** Fetch a persona by id; throws if unknown so callers fail loudly. */
export function getPersona(id: PersonaId): Persona {
	const p = registry().get(id);
	if (!p) throw new Error(`Unknown persona id: ${id}`);
	return p;
}

export function listPersonas(): Persona[] {
	return Array.from(registry().values());
}

export function listPersonaIds(): PersonaId[] {
	return Array.from(registry().keys());
}

export function listWorkerPersonas(): Persona[] {
	return listPersonas().filter((p) => p.kind === "worker");
}

export function listPersonasByStage(stage: PersonaStage): Persona[] {
	return listWorkerPersonas().filter((p) => p.orchestration.stage === stage);
}

export function isPerceptionPersona(id: PersonaId): boolean {
	return getPersona(id).orchestration.stage === "perception";
}

export function isPlanGatedPersona(id: PersonaId): boolean {
	return getPersona(id).orchestration.planGate !== "never";
}

export function personaCapForRoute(id: PersonaId, route: PersonaRouteRole, _scale?: string): PersonaTaskCap | undefined {
	return getPersona(id).orchestration.defaultTaskCap?.[route];
}

export function normalizePersonaIdOrAlias(raw: string): PersonaId | undefined {
	const normalized = normalizePersonaToken(raw);
	for (const persona of listPersonas()) {
		if (persona.id === normalized) return persona.id;
		if (persona.orchestration.repairAliases.some((alias) => normalizePersonaToken(alias) === normalized)) {
			return persona.id;
		}
	}
	return undefined;
}

export function registerPersonaForTesting(persona: Persona): () => void {
	const reg = registry();
	const previous = reg.get(persona.id);
	reg.set(persona.id, persona);
	refreshMasterPrompt(reg);
	return () => {
		if (previous) reg.set(persona.id, previous);
		else reg.delete(persona.id);
		refreshMasterPrompt(reg);
	};
}

/** True if any persona declares this tool in its allowlist. */
export function isToolAllowedForAny(toolName: string): boolean {
	for (const p of registry().values()) {
		if (p.toolAllowlist.includes(toolName)) return true;
	}
	return false;
}

function normalizePersonaToken(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[`*]/g, "")
		.replace(/[\s-]+/g, "_");
}

function refreshMasterPrompt(reg: Map<PersonaId, Persona>): void {
	const master = reg.get("master_planner");
	if (master) master.systemPrompt = buildMasterPrompt(reg.values());
}
