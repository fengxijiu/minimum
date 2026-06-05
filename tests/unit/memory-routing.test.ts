import { describe, expect, it } from "vitest";
import {
	availableCanonicalMemoryTargets,
	defaultMemorySectionForCandidate,
	defaultMemoryTargetForCandidate,
} from "../../src/memory/governance/index.js";
import type { MemoryCandidate } from "../../src/memory/governance/types.js";

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
	return {
		sourceTask: "T-route-1",
		persona: "code_executor",
		scope: "frontend/upload",
		confidence: "high",
		relatedFiles: ["src/upload.ts"],
		body: "Upload behavior is durable project knowledge.",
		...overrides,
	};
}

describe("MemoryRouting", () => {
	it("maps frontend scopes to frontend.md", () => {
		expect(defaultMemoryTargetForCandidate(candidate())).toBe("frontend.md");
	});

	it("maps backend scopes to backend.md", () => {
		expect(
			defaultMemoryTargetForCandidate(candidate({ scope: "backend/upload" })),
		).toBe("backend.md");
	});

	it("maps api scopes to api.md", () => {
		expect(defaultMemoryTargetForCandidate(candidate({ scope: "api/upload" }))).toBe(
			"api.md",
		);
	});

	it("falls back to project.md for unknown scopes", () => {
		expect(
			defaultMemoryTargetForCandidate(candidate({ scope: "observations" })),
		).toBe("project.md");
	});

	it("derives section names from the scope root", () => {
		expect(defaultMemorySectionForCandidate(candidate({ scope: "backend/upload" }))).toBe(
			"Backend",
		);
		expect(defaultMemorySectionForCandidate(candidate({ scope: "none" }))).toBe(
			"Notes",
		);
	});

	it("lists canonical target choices from manifest defaults", () => {
		expect(availableCanonicalMemoryTargets()).toEqual(
			expect.arrayContaining([
				"project.md",
				"architecture.md",
				"conventions.md",
				"repo-map.md",
				"tests.md",
				"visual.md",
				"runtime.md",
				"risks.md",
				"decisions.md",
				"api.md",
				"frontend.md",
				"backend.md",
			]),
		);
	});
});
