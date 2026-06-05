import { describe, expect, it } from "vitest";
import {
	buildArtifactMap,
	evaluateLaunchGate,
} from "../../src/orchestration/index.js";
import type { TaskContract, TaskResult } from "../../src/orchestration/index.js";

function mkResult(report: string): TaskResult {
	return {
		taskId: "T0-1",
		personaId: "repo_scout",
		status: "ok",
		report,
		memoryCandidateBody: undefined,
		errors: [],
		durationMs: 1,
	};
}

function mkContract(overrides: Partial<TaskContract> = {}): TaskContract {
	return {
		taskId: "T2-1",
		phase: "P2",
		epicId: "image_upload",
		personaId: "code_executor",
		objective: "implement upload endpoint",
		inputs: { userGoal: "build upload", artifacts: [], constraints: [], staticCompileCommands: [] },
		pathPolicy: { allowedGlobs: ["src/upload.ts"], forbiddenGlobs: [] },
		acceptance: ["returns 201"],
		nonGoals: ["do not redesign the upload page"],
		blockedCondition: "blocked if repo static compile command is unavailable",
		launchRequirements: [{ sourceTaskId: "T0-1", artifact: "static_compile_commands", required: true }],
		postStaticCompile: { required: true, commands: [] },
		outputSchema: "task_report",
		parallelGroup: "backend",
		dependsOn: ["T0-1"],
		grantedSkills: [],
		grantedMcpTools: [],
		abortOnConflict: false,
		...overrides,
	};
}

describe("buildArtifactMap", () => {
	it("extracts static_compile_commands from repo_scout reports", () => {
		const artifacts = buildArtifactMap([
			mkResult(`<task_report><status>ok</status><static_compile_commands>
- command: npm run typecheck
  source: package.json scripts.typecheck
  confidence: high
</static_compile_commands></task_report>`),
		]);
		expect(artifacts.get("T0-1")?.get("static_compile_commands")).toContain("npm run typecheck");
	});
});

describe("evaluateLaunchGate", () => {
	it("accepts static_compile_commands as a supported launch artifact", () => {
		const result = mkResult(`<task_report><status>ok</status><static_compile_commands>
- command: npm run typecheck
  source: package.json scripts.typecheck
  confidence: high
</static_compile_commands></task_report>`);
		const decision = evaluateLaunchGate(
			mkContract({
				inputs: { userGoal: "build upload", artifacts: [], constraints: [], staticCompileCommands: ["npm run typecheck"] },
				postStaticCompile: { required: true, commands: ["npm run typecheck"] },
			}),
			[result],
			buildArtifactMap([result]),
		);
		expect(decision.ok).toBe(true);
	});

	it("blocks postStaticCompile tasks when no commands are available", () => {
		const decision = evaluateLaunchGate(
			mkContract(),
			[mkResult(`<task_report><status>ok</status><file_list>- src/upload.ts</file_list></task_report>`)],
			buildArtifactMap([mkResult(`<task_report><status>ok</status><file_list>- src/upload.ts</file_list></task_report>`)]),
		);
		expect(decision.ok).toBe(false);
		expect(decision.issues.some((issue) => issue.reason.includes("static compile command"))).toBe(true);
	});
});
