import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	GLOBAL_FORBIDDEN_WRITES,
	WORKER_FORBIDDEN_WRITES,
	type Persona,
	type PersonaId,
} from "./Persona.js";

const PROMPTS_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"prompts",
);

function loadPrompt(file: string): string {
	return fs.readFileSync(path.join(PROMPTS_DIR, file), "utf-8");
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

/**
 * Construct the canonical set of 10 personas. Called once at module load.
 *
 * Persona definitions are intentionally static — master_planner picks from
 * this fixed roster. Adding a new role requires a code change so its tool
 * allowlist and path policy are reviewed.
 */
function buildPersonas(): Map<PersonaId, Persona> {
	const footer = loadPrompt("_common-footer.md");
	const masterPrompt = loadPrompt("master-planner.md");

	const out = new Map<PersonaId, Persona>();

	out.set("master_planner", {
		id: "master_planner",
		kind: "master",
		model: "mimo-v2.5-pro",
		systemPrompt: masterPrompt,
		toolAllowlist: [
			"read_file",
			"list_directory",
			"grep",
			"glob",
			"git_status",
			"git_diff",
			"git_log",
			"write_file",
			"edit_file",
			"apply_patch",
		],
		toolDenylist: ["exec_shell"],
		pathPolicy: {
			canWrite: true,
			alwaysAllowedGlobs: [".minimum/**", "tasks/**"],
			forbiddenGlobs: GLOBAL_FORBIDDEN_WRITES,
		},
		maxSteps: 60,
		maxTokens: 200_000,
		outputSchema: "planner_dag",
		parallelism: { soloPerWave: true, maxConcurrent: 1 },
	});

	out.set("vision", {
		id: "vision",
		kind: "worker",
		model: "mimo-omni",
		systemPrompt: buildWorkerPrompt("vision.md", footer),
		toolAllowlist: ["read_file", "list_directory"],
		toolDenylist: ["write_file", "edit_file", "apply_patch", "exec_shell"],
		pathPolicy: {
			canWrite: false,
			alwaysAllowedGlobs: [],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 8,
		maxTokens: 32_000,
		outputSchema: "vision_report",
		parallelism: { soloPerWave: false, maxConcurrent: 1 },
	});

	out.set("repo_scout", {
		id: "repo_scout",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildWorkerPrompt("repo-scout.md", footer),
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
		maxSteps: 15,
		maxTokens: 32_000,
		outputSchema: "scout_report",
		parallelism: { soloPerWave: false, maxConcurrent: 2 },
	});

	out.set("context_builder", {
		id: "context_builder",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildWorkerPrompt("context-builder.md", footer),
		toolAllowlist: ["read_file", "list_directory", "write_file"],
		toolDenylist: ["edit_file", "apply_patch", "exec_shell"],
		pathPolicy: {
			canWrite: true,
			// Only allowed to write under per-epic context-packs dir; the actual
			// taskId-scoped path is locked in by the Task Contract.
			alwaysAllowedGlobs: ["tasks/**/context-packs/**"],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 10,
		maxTokens: 32_000,
		outputSchema: "context_pack",
		parallelism: { soloPerWave: false, maxConcurrent: 1 },
	});

	out.set("code_executor", {
		id: "code_executor",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildWorkerPrompt("code-executor.md", footer),
		toolAllowlist: [
			"read_file",
			"list_directory",
			"grep",
			"glob",
			"write_file",
			"edit_file",
			"apply_patch",
			"git_status",
			"git_diff",
		],
		toolDenylist: ["exec_shell"],
		pathPolicy: {
			canWrite: true,
			// allowedGlobs left empty; the Task Contract must populate them.
			// Without contract globs, PathPolicyEnforcer denies all writes
			// except the staging memory file.
			alwaysAllowedGlobs: [],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 40,
		maxTokens: 64_000,
		outputSchema: "task_report",
		parallelism: { soloPerWave: false, maxConcurrent: 2 },
	});

	out.set("test_writer", {
		id: "test_writer",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildWorkerPrompt("test-writer.md", footer),
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
		maxSteps: 20,
		maxTokens: 48_000,
		outputSchema: "test_report",
		parallelism: { soloPerWave: false, maxConcurrent: 2 },
	});

	out.set("test_runner", {
		id: "test_runner",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildWorkerPrompt("test-runner.md", footer),
		toolAllowlist: ["read_file", "exec_shell"],
		toolDenylist: ["write_file", "edit_file", "apply_patch"],
		pathPolicy: {
			canWrite: false,
			alwaysAllowedGlobs: [],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 6,
		maxTokens: 32_000,
		outputSchema: "test_report",
		parallelism: { soloPerWave: false, maxConcurrent: 2 },
	});

	out.set("runtime_debug", {
		id: "runtime_debug",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildWorkerPrompt("runtime-debug.md", footer),
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
			alwaysAllowedGlobs: ["tasks/**/artifacts/**"],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 15,
		maxTokens: 32_000,
		outputSchema: "debug_report",
		parallelism: { soloPerWave: true, maxConcurrent: 1 },
	});

	out.set("reviewer", {
		id: "reviewer",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildWorkerPrompt("reviewer.md", footer),
		toolAllowlist: ["read_file", "grep", "glob", "git_diff"],
		toolDenylist: ["write_file", "edit_file", "apply_patch", "exec_shell"],
		pathPolicy: {
			canWrite: false,
			alwaysAllowedGlobs: [],
			forbiddenGlobs: WORKER_FORBIDDEN_WRITES,
		},
		maxSteps: 10,
		maxTokens: 48_000,
		outputSchema: "review_report",
		parallelism: { soloPerWave: false, maxConcurrent: 1 },
	});

	out.set("docs", {
		id: "docs",
		kind: "worker",
		model: "mimo-v2.5",
		systemPrompt: buildWorkerPrompt("docs.md", footer),
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
		maxSteps: 12,
		maxTokens: 32_000,
		outputSchema: "task_report",
		parallelism: { soloPerWave: false, maxConcurrent: 1 },
	});

	return out;
}

const REGISTRY: Map<PersonaId, Persona> = buildPersonas();

/** Fetch a persona by id; throws if unknown so callers fail loudly. */
export function getPersona(id: PersonaId): Persona {
	const p = REGISTRY.get(id);
	if (!p) throw new Error(`Unknown persona id: ${id}`);
	return p;
}

export function listPersonas(): Persona[] {
	return Array.from(REGISTRY.values());
}

export function listPersonaIds(): PersonaId[] {
	return Array.from(REGISTRY.keys());
}

/** True if any persona declares this tool in its allowlist. */
export function isToolAllowedForAny(toolName: string): boolean {
	for (const p of REGISTRY.values()) {
		if (p.toolAllowlist.includes(toolName)) return true;
	}
	return false;
}
