import { describe, expect, it } from "vitest";
import {
	GLOBAL_FORBIDDEN_WRITES,
	getPersona,
	listPersonaIds,
	listPersonas,
	type PersonaId,
} from "../../src/personas/index.js";

const EXPECTED_IDS: PersonaId[] = [
	"master_planner",
	"vision",
	"repo_scout",
	"context_builder",
	"code_executor",
	"test_writer",
	"test_runner",
	"runtime_debug",
	"reviewer",
	"docs",
];

describe("PersonaRegistry", () => {
	it("registers all 10 expected personas", () => {
		const ids = listPersonaIds();
		expect(ids.sort()).toEqual([...EXPECTED_IDS].sort());
	});

	it("has exactly one master persona", () => {
		const masters = listPersonas().filter((p) => p.kind === "master");
		expect(masters).toHaveLength(1);
		expect(masters[0]!.id).toBe("master_planner");
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
	});

	describe("system prompt loading", () => {
		it("every worker prompt contains the output protocol footer", () => {
			for (const p of listPersonas()) {
				if (p.kind === "master") continue;
				expect(p.systemPrompt).toContain("<task_report>");
				expect(p.systemPrompt).toContain("<memory_candidate>");
				expect(p.systemPrompt).toContain("Blocked Protocol");
			}
		});

		it("master prompt does NOT contain the worker footer", () => {
			const master = getPersona("master_planner").systemPrompt;
			// Master uses its own DAG/finalize schema, not task_report.
			expect(master).toContain("<task_dag>");
			expect(master).toContain("<finalize>");
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

		it("vision uses omni model (image support)", () => {
			expect(getPersona("vision").model).toBe("mimo-omni");
		});

		it("all non-master, non-vision workers use v2.5", () => {
			for (const p of listPersonas()) {
				if (p.id === "master_planner" || p.id === "vision") continue;
				expect(p.model).toBe("mimo-v2.5");
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
	});
});
