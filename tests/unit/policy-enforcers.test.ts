import { describe, expect, it } from "vitest";
import { getPersona } from "../../src/personas/PersonaRegistry.js";
import {
	checkTool,
	checkWrite,
	filterAllowedTools,
	matchGlob,
	type PolicyContext,
} from "../../src/tools/policy/index.js";
import type { TaskContract } from "../../src/orchestration/TaskContract.js";

const ROOT = "/work/project";

function ctx(
	personaId:
		| "code_executor"
		| "vision"
		| "reviewer"
		| "test_writer"
		| "docs"
		| "runtime_debug"
		| "master_planner",
	contract?: Partial<TaskContract>,
): PolicyContext {
	const persona = getPersona(personaId);
	const base: TaskContract = {
		taskId: "T-1",
		phase: "P1",
		epicId: "E",
		personaId,
		objective: "test contract",
		inputs: { userGoal: "x", artifacts: [], constraints: [] },
		pathPolicy: { allowedGlobs: ["src/**/*.ts"], forbiddenGlobs: [] },
		acceptance: ["a"],
		outputSchema: persona.outputSchema,
		parallelGroup: "g",
		dependsOn: [],
		abortOnConflict: false,
	};
	return {
		persona,
		projectRoot: ROOT,
		contract: { ...base, ...(contract ?? {}) },
	};
}

describe("matchGlob", () => {
	const cases: Array<[string, string, boolean]> = [
		["src/a.ts", "src/**/*.ts", true],
		["src/x/y/z.ts", "src/**/*.ts", true],
		["src/a.js", "src/**/*.ts", false],
		[".env", ".env", true],
		[".env.local", ".env.*", true],
		["package-lock.json", "package-lock.json", true],
		[".git/HEAD", ".git/**", true],
		["dist/index.js", ".git/**", false],
		["tests/unit/foo.test.ts", "**/*.test.ts", true],
		["frontend/src/Foo.tsx", "frontend/src/**", true],
		["frontend/src/Foo.tsx", "backend/**", false],
		[".minimum/_archive/x.md", ".minimum/_archive/**", true],
		[".minimum/architecture.md", ".minimum/**", true],
	];
	for (const [p, g, expected] of cases) {
		it(`${p} ~ ${g} → ${expected}`, () => {
			expect(matchGlob(p, g)).toBe(expected);
		});
	}
});

describe("checkWrite — read-only personas", () => {
	for (const id of ["vision", "reviewer"] as const) {
		it(`${id} is denied with PERSONA_READ_ONLY`, () => {
			const r = checkWrite("src/foo.ts", ctx(id, {
				pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
			}));
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.code).toBe("PERSONA_READ_ONLY");
		});
	}
});

describe("checkWrite — forbidden globs", () => {
	it("blocks .env (GLOBAL_FORBIDDEN_WRITES)", () => {
		const r = checkWrite(".env", ctx("code_executor"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("FORBIDDEN_PATH");
	});

	it("blocks .git/HEAD", () => {
		const r = checkWrite(".git/HEAD", ctx("code_executor"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("FORBIDDEN_PATH");
	});

	it("blocks node_modules subpaths", () => {
		const r = checkWrite("node_modules/foo/index.js", ctx("code_executor"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("FORBIDDEN_PATH");
	});

	it("forbidden wins over allowed", () => {
		const r = checkWrite(".env", ctx("code_executor", {
			pathPolicy: { allowedGlobs: [".env"], forbiddenGlobs: [] },
		}));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("FORBIDDEN_PATH");
	});
});

describe("checkWrite — allowed globs", () => {
	it("allows path matching contract allowedGlobs", () => {
		const r = checkWrite("src/components/Upload.tsx", ctx("code_executor", {
			pathPolicy: { allowedGlobs: ["src/**/*.tsx"], forbiddenGlobs: [] },
		}));
		expect(r.ok).toBe(true);
	});

	it("denies path outside contract allowedGlobs", () => {
		const r = checkWrite("backend/api.py", ctx("code_executor", {
			pathPolicy: { allowedGlobs: ["src/**/*.tsx"], forbiddenGlobs: [] },
		}));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("NOT_IN_ALLOWED_GLOBS");
	});

	it("test_writer falls back to persona alwaysAllowedGlobs when contract is empty", () => {
		const r = checkWrite("tests/unit/foo.test.ts", ctx("test_writer", {
			pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		}));
		expect(r.ok).toBe(true);
	});

	it("docs writes to README.md", () => {
		const r = checkWrite("README.md", ctx("docs", {
			pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		}));
		expect(r.ok).toBe(true);
	});

	it("docs cannot write business code", () => {
		const r = checkWrite("src/index.ts", ctx("docs", {
			pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		}));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("NOT_IN_ALLOWED_GLOBS");
	});

	it("runtime_debug writes diagnostic artifacts", () => {
		const r = checkWrite("tasks/E/artifacts/runtime-debug.md", ctx("runtime_debug", {
			pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		}));
		expect(r.ok).toBe(true);
	});

	it("runtime_debug cannot write business code", () => {
		const r = checkWrite("src/index.ts", ctx("runtime_debug", {
			pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		}));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("NOT_IN_ALLOWED_GLOBS");
	});

	it("master_planner can write under .minimum/**", () => {
		const r = checkWrite(".minimum/architecture.md", ctx("master_planner", {
			pathPolicy: { allowedGlobs: [], forbiddenGlobs: [] },
		}));
		expect(r.ok).toBe(true);
	});
});

describe("checkWrite — path safety", () => {
	it("blocks parent traversal", () => {
		const r = checkWrite("../etc/passwd", ctx("code_executor"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("PATH_TRAVERSAL");
	});

	it("blocks parent-escape via mid-path /../", () => {
		// src/../../ normalizes to ../, escaping the project root.
		const r = checkWrite("src/../../etc/passwd", ctx("code_executor"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("PATH_TRAVERSAL");
	});

	it("normalizes intra-project /../ without flagging traversal", () => {
		// src/a/../../etc/passwd normalizes to etc/passwd — still inside the
		// project, so this is NOT_IN_ALLOWED_GLOBS, not PATH_TRAVERSAL.
		const r = checkWrite("src/a/../../etc/passwd", ctx("code_executor"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("NOT_IN_ALLOWED_GLOBS");
	});

	it("rejects absolute path outside project root", () => {
		const r = checkWrite("/etc/passwd", ctx("code_executor"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("ABSOLUTE_PATH");
	});

	it("accepts absolute path inside project root", () => {
		const r = checkWrite(`${ROOT}/src/x.ts`, ctx("code_executor", {
			pathPolicy: { allowedGlobs: ["src/**/*.ts"], forbiddenGlobs: [] },
		}));
		expect(r.ok).toBe(true);
	});
});

describe("checkTool", () => {
	it("denies tools in the denylist", () => {
		const r = checkTool("exec_shell", getPersona("vision"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("IN_DENYLIST");
	});

	it("denies tools not in the allowlist", () => {
		const r = checkTool("network_install", getPersona("code_executor"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("NOT_IN_ALLOWLIST");
	});

	it("allows tools that are in the allowlist and not denylisted", () => {
		const r = checkTool("read_file", getPersona("vision"));
		expect(r.ok).toBe(true);
	});

	it("denylist wins over allowlist", () => {
		// edit_file is in code_executor's allowlist but if put in denylist, deny.
		// We synthesize the case by manually checking against a stub persona.
		const persona = {
			...getPersona("code_executor"),
			toolDenylist: [...getPersona("code_executor").toolDenylist, "edit_file"],
		};
		const r = checkTool("edit_file", persona);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("IN_DENYLIST");
	});
});

describe("filterAllowedTools", () => {
	it("keeps only persona-allowed tools", () => {
		const tools = ["read_file", "write_file", "exec_shell", "grep"];
		const got = filterAllowedTools(tools, getPersona("vision"));
		expect(got).toEqual(["read_file"]);
	});

	it("test_runner keeps exec_shell only among write/exec tools", () => {
		const tools = ["exec_shell", "write_file", "edit_file", "read_file"];
		const got = filterAllowedTools(tools, getPersona("test_runner"));
		expect(got.sort()).toEqual(["exec_shell", "read_file"]);
	});
});

describe("invariant: no worker except master_planner can write .minimum/*.md", () => {
	const workerIds = [
		"vision", "repo_scout", "context_builder", "code_executor",
		"test_writer", "test_runner", "runtime_debug", "reviewer", "docs",
	] as const;
	for (const id of workerIds) {
		it(`${id} cannot write .minimum/architecture.md`, () => {
			// Even with a maximally-permissive contract, the persona's forbidden
			// globs or canWrite or allowedGlobs scope prevents the write.
			const persona = getPersona(id);
			const contract: TaskContract = {
				taskId: "T-x",
				phase: "P",
				epicId: "E",
				personaId: id,
				objective: "attack vector — should be denied",
				inputs: { userGoal: "x", artifacts: [], constraints: [] },
				pathPolicy: { allowedGlobs: [".minimum/**"], forbiddenGlobs: [] },
				acceptance: ["a"],
				outputSchema: persona.outputSchema,
				parallelGroup: "g",
				dependsOn: [],
				abortOnConflict: false,
			};
			const r = checkWrite(".minimum/architecture.md", {
				persona, contract, projectRoot: ROOT,
			});
			expect(r.ok).toBe(false);
		});
	}
});
