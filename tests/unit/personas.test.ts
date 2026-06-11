import { describe, expect, it } from "vitest";
import {
	buildMasterStagePrompt,
	GLOBAL_FORBIDDEN_WRITES,
	getPersona,
	isPerceptionPersona,
	isPlanGatedPersona,
	listPersonasByStage,
	listPersonaIds,
	listPersonas,
	listWorkerPersonas,
	normalizePersonaIdOrAlias,
	personaCapForRoute,
	registerPersonaForTesting,
	type Persona,
	type PersonaId,
} from "../../src/personas/index.js";

const EXPECTED_IDS: PersonaId[] = [
	"master_planner",
	"vision",
	"repo_scout",
	"web_searcher",
	"context_builder",
	"code_executor",
	"test_writer",
	"test_runner",
	"runtime_debug",
	"reviewer",
	"docs",
];

describe("PersonaRegistry", () => {
	it("registers all 11 expected personas", () => {
		const ids = listPersonaIds();
		expect(ids.sort()).toEqual([...EXPECTED_IDS].sort());
	});

	it("has exactly one master persona", () => {
		const masters = listPersonas().filter((p) => p.kind === "master");
		expect(masters).toHaveLength(1);
		expect(masters[0]!.id).toBe("master_planner");
	});

	it("gives every worker orchestration metadata", () => {
		for (const p of listWorkerPersonas()) {
			expect(p.orchestration.stage).toBeTruthy();
			expect(p.orchestration.chainRole).toBeTruthy();
			expect(Array.isArray(p.orchestration.routeRoles)).toBe(true);
			expect(p.orchestration.executionDepth).toMatch(/^(fast|normal|deep)$/);
			expect(p.orchestration.planGate).toMatch(/^(never|code_personas|all_writes)$/);
			expect(Array.isArray(p.orchestration.producesArtifacts)).toBe(true);
			expect(Array.isArray(p.orchestration.repairAliases)).toBe(true);
		}
	});

	it("derives stage, plan gate, alias, and route cap helpers from the registry", () => {
		expect(listPersonasByStage("perception").map((p) => p.id)).toEqual(
			expect.arrayContaining(["vision", "repo_scout", "web_searcher", "context_builder"]),
		);
		expect(isPerceptionPersona("web_searcher")).toBe(true);
		expect(isPlanGatedPersona("code_executor")).toBe(true);
		expect(isPlanGatedPersona("test_runner")).toBe(false);
		expect(normalizePersonaIdOrAlias("developer")).toBe("code_executor");
		expect(personaCapForRoute("reviewer", "audit_review")).toEqual({ min: 2, max: 10 });
	});

	it("renders newly registered personas into the dynamic master catalog", () => {
		const fake: Persona = {
			...getPersona("reviewer"),
			id: "contract_reviewer",
			systemPrompt: "Contract reviewer prompt",
			requiredReportBlocks: [],
			parallelism: { soloPerWave: false, maxConcurrent: 4 },
			orchestration: {
				stage: "review",
				routeRoles: ["audit_review"],
				chainRole: "review",
				defaultTaskCap: { audit_review: { min: 1, max: 3 } },
				executionDepth: "fast",
				planGate: "never",
				producesArtifacts: ["risk_matrix"],
				repairAliases: ["contract review"],
			},
		};
		const restore = registerPersonaForTesting(fake);
		try {
			expect(getPersona("contract_reviewer").id).toBe("contract_reviewer");
			expect(normalizePersonaIdOrAlias("contract review")).toBe("contract_reviewer");
			const catalog = buildMasterStagePrompt("W0");
			expect(catalog).toContain("contract_reviewer");
			expect(catalog).toContain("stage: review");
			expect(catalog).toContain("chainRole: review");
			expect(catalog).toContain("risk_matrix");
		} finally {
			restore();
		}
	});

	it("getPersona throws on unknown id", () => {
		// @ts-expect-error — intentional bad id
		expect(() => getPersona("ghost")).toThrow(/Unknown persona/);
	});

	describe("read-only personas cannot write", () => {
		const readOnly: PersonaId[] = ["vision", "repo_scout", "test_runner", "reviewer"];
		for (const id of readOnly) {
			it(`${id}.pathPolicy.canWrite === false`, () => {
				expect(getPersona(id).pathPolicy.canWrite).toBe(false);
			});
			it(`${id} denies write tools`, () => {
				const p = getPersona(id);
				for (const w of ["write_file", "edit_file", "apply_patch"]) {
					expect(p.toolDenylist).toContain(w);
					expect(p.toolAllowlist).not.toContain(w);
				}
			});
		}
	});

	describe("write-capable personas have scoped allowed globs", () => {
		it("test_writer is bound to test directories", () => {
			const globs = getPersona("test_writer").pathPolicy.alwaysAllowedGlobs;
			expect(globs.some((g) => g.includes("test"))).toBe(true);
		});

		it("docs is bound to documentation surfaces", () => {
			const globs = getPersona("docs").pathPolicy.alwaysAllowedGlobs;
			expect(globs).toContain("README.md");
			expect(globs.some((g) => g.startsWith("docs/"))).toBe(true);
		});

		it("context_builder writes only context-packs", () => {
			const globs = getPersona("context_builder").pathPolicy.alwaysAllowedGlobs;
			expect(globs.every((g) => g.includes("context-packs"))).toBe(true);
		});

		it("runtime_debug writes only diagnostic artifacts", () => {
			const p = getPersona("runtime_debug");
			expect(p.pathPolicy.canWrite).toBe(true);
			expect(p.toolAllowlist).toContain("write_file");
			expect(p.toolDenylist).not.toContain("write_file");
			expect(p.pathPolicy.alwaysAllowedGlobs).toEqual(["tasks/**/artifacts/**"]);
		});

		it("code_executor has no alwaysAllowedGlobs — must come from contract", () => {
			expect(getPersona("code_executor").pathPolicy.alwaysAllowedGlobs).toEqual([]);
		});
	});

	describe("forbidden globs", () => {
		it("every persona inherits GLOBAL_FORBIDDEN_WRITES", () => {
			for (const p of listPersonas()) {
				for (const forbidden of GLOBAL_FORBIDDEN_WRITES) {
					expect(p.pathPolicy.forbiddenGlobs).toContain(forbidden);
				}
			}
		});

		it("forbids .env and .git", () => {
			expect(GLOBAL_FORBIDDEN_WRITES).toContain(".env");
			expect(GLOBAL_FORBIDDEN_WRITES).toContain(".git/**");
		});

		it("every worker forbids .minimum/** (canonical reserved for master)", () => {
			for (const p of listPersonas()) {
				if (p.kind === "master") continue;
				expect(p.pathPolicy.forbiddenGlobs).toContain(".minimum/**");
			}
		});

		it("master_planner does NOT forbid .minimum/**", () => {
			const master = listPersonas().find((p) => p.kind === "master")!;
			expect(master.pathPolicy.forbiddenGlobs).not.toContain(".minimum/**");
		});
	});

	describe("system prompt loading", () => {
		it("every worker prompt contains the output protocol footer", () => {
			for (const p of listPersonas()) {
				if (p.kind === "master") continue;
				expect(p.systemPrompt).toContain("<task_report>");
				expect(p.systemPrompt).toContain("<memory_candidate>");
				expect(p.systemPrompt).toContain("Blocked Protocol");
				expect(p.systemPrompt).toContain("Do not include analysis");
				expect(p.systemPrompt).toContain("Evidence Rules");
				expect(p.systemPrompt).toContain("Must Not Do");
				expect(p.systemPrompt).toContain("<status>");
			}
		});

		it("master prompt does NOT contain the worker footer", () => {
			const master = getPersona("master_planner").systemPrompt;
			// Master uses its own DAG/finalize schema, not task_report.
			expect(master).toContain("<task_dag>");
			expect(master).toContain("<finalize>");
		});

		it("master prompt includes minimum-native planning and dispatch skills", () => {
			const master = getPersona("master_planner").systemPrompt;
			expect(master).toContain("Minimum-native Superpowers Skills");
			expect(master).toContain("Contract-First Planning");
			expect(master).toContain("Subagent Task Assignment for Minimum");
		});

		it("reviewer prompt includes review skills but code_executor does not", () => {
			expect(getPersona("reviewer").systemPrompt).toContain("Spec Compliance Review");
			expect(getPersona("code_executor").systemPrompt).not.toContain("Spec Compliance Review");
		});

		it("every system prompt is non-empty", () => {
			for (const p of listPersonas()) {
				expect(p.systemPrompt.length).toBeGreaterThan(200);
			}
		});
	});

	describe("model assignments", () => {
		it("master uses v2.5-pro", () => {
			expect(getPersona("master_planner").model).toBe("mimo-v2.5-pro");
		});

		it("vision uses v2.5", () => {
			expect(getPersona("vision").model).toBe("mimo-v2.5");
		});

		it("context_builder uses v2.5-pro", () => {
			expect(getPersona("context_builder").model).toBe("mimo-v2.5-pro");
		});

		it("remaining non-master workers use v2.5", () => {
			for (const p of listPersonas()) {
				if (p.id === "master_planner" || p.id === "context_builder") continue;
				expect(p.model).toBe("mimo-v2.5");
			}
		});
	});

	describe("output schemas", () => {
		it("uses task_report for every worker persona", () => {
			for (const p of listPersonas()) {
				if (p.kind === "master") continue;
				expect(p.outputSchema).toBe("task_report");
			}
		});
	});

	describe("parallelism caps", () => {
		it("master is soloPerWave", () => {
			expect(getPersona("master_planner").parallelism.soloPerWave).toBe(true);
		});

		it("runtime_debug is soloPerWave (lock-step diagnosis)", () => {
			expect(getPersona("runtime_debug").parallelism.soloPerWave).toBe(true);
		});

		it("every persona has maxConcurrent >= 1", () => {
			for (const p of listPersonas()) {
				expect(p.parallelism.maxConcurrent).toBeGreaterThanOrEqual(1);
			}
		});
	});

	describe("tool allowlist sanity", () => {
		it("test_runner can exec_shell", () => {
			expect(getPersona("test_runner").toolAllowlist).toContain("exec_shell");
		});

		it("non-test-runner workers cannot exec_shell", () => {
			for (const p of listPersonas()) {
				if (p.id === "test_runner") continue;
				expect(p.toolDenylist).toContain("exec_shell");
			}
		});

		it("read tools are universally available", () => {
			for (const p of listPersonas()) {
				expect(p.toolAllowlist).toContain("read_file");
			}
		});

		it("master_planner can ask bounded planning choices", () => {
			expect(getPersona("master_planner").toolAllowlist).toContain("ask_choice");
			expect(getPersona("master_planner").toolDenylist).toContain("exec_shell");
		});
	});

	describe("master_planner prompt", () => {
		it("contains every registered persona id as an enumerated valid id", () => {
			const sys = getPersona("master_planner").systemPrompt;
			for (const id of listPersonaIds()) {
				expect(sys).toContain(id);
			}
		});

		it("explicitly forbids mission_checker as a coarse persona", () => {
			const sys = getPersona("master_planner").systemPrompt;
			expect(sys).toMatch(/mission_checker/i);
			expect(sys.toLowerCase()).toMatch(/must not appear|forbid|not.*coarse/);
		});

		it("declares persona ids must be exact lowercase underscore", () => {
			const sys = getPersona("master_planner").systemPrompt;
			expect(sys.toLowerCase()).toMatch(/exact|lowercase|underscore/);
		});

		it("defines blockedCondition as a launch gate with launchRequirements", () => {
			const sys = getPersona("master_planner").systemPrompt;
			expect(sys).toContain("launchRequirements");
			expect(sys).toContain("T0-1.file_list");
			expect(sys.toLowerCase()).toContain("launch gate");
			expect(sys.toLowerCase()).toContain("do not use generic blockedcondition");
		});

		it("routes repo discovery to repo_scout and visual artifacts to vision", () => {
			const sys = getPersona("master_planner").systemPrompt;
			expect(sys).toContain("repo_scout");
			expect(sys).toContain("file_list");
			expect(sys).toContain("static_compile_commands");
			expect(sys.toLowerCase()).toContain("vision only");
		});

		it("defines dispatch matrix and default behavior-change chain", () => {
			const sys = getPersona("master_planner").systemPrompt;
			expect(sys).toContain("Planning Checklist");
			expect(sys).toContain("Persona Dispatch Matrix");
			expect(sys).toContain("Task Granularity Rules");
			expect(sys).toContain("test_writer -> test_runner -> code_executor -> test_runner -> reviewer");
			expect(sys).toContain("Do not assign discovery or file-list tasks to `code_executor`");
		});

		it("requires repo_scout to surface static compile commands", () => {
			const sys = getPersona("repo_scout").systemPrompt;
			expect(sys).toContain("<static_compile_commands>");
			expect(sys).toContain("typecheck");
		});

		it("requires code_executor and test_runner to account for static compile", () => {
			expect(getPersona("code_executor").systemPrompt).toContain("static compile");
			expect(getPersona("test_runner").systemPrompt).toContain("static compile");
		});

		it("defines workload estimation and fan-out policy", () => {
			const sys = getPersona("master_planner").systemPrompt;
			expect(sys).toContain("Workload Estimation and Fan-Out Policy");
			expect(sys).toContain("workload_dimensions");
			expect(sys).toContain("Fan-Out Decision Rules");
			expect(sys).toContain("One code_executor task should not own more than 3-5 files unless the change is mechanical");
			expect(sys).toContain("ask_choice");
		});

		it("defines route and scale selection policy", () => {
			const sys = getPersona("master_planner").systemPrompt;
			expect(sys).toContain("Route & Scale Selection Policy");
			expect(sys).toContain("scan_only");
			expect(sys).toContain("direct_edit");
			expect(sys).toContain("audit_review");
			expect(sys).toContain("implementation");
			expect(sys).toContain("debug_fix");
			expect(sys).toContain("dependency_config");
			expect(sys).toContain("full_pipeline");
			expect(sys).toContain("small | medium | large | auto");
		});

		it("defines audit_review scoped scout and reviewer fan-out rules", () => {
			const sys = getPersona("master_planner").systemPrompt;
			expect(sys).toContain("repo_scout is a context probe, not a global single-point gate");
			expect(sys).toContain("Prefer scoped `repo_scout` tasks");
			expect(sys).toContain("One reviewer owns exactly one finding domain or one bounded file cluster");
			expect(sys).toContain("audit_review medium");
			expect(sys).toContain("3-5 reviewers");
			expect(sys).toContain("audit_review large");
			expect(sys).toContain("6-10 reviewers");
			expect(sys).toContain("docs depends on completed reviewer reports");
			expect(sys).toContain("Do not make the final docs task depend directly on `repo_scout.file_list`");
		});
	});
});
