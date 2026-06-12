import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildContextPack,
	contextPackPath,
	rankCandidates,
	writeContextPack,
	type CanonicalSection,
} from "../../src/memory/governance/index.js";
import type { MemoryCandidate } from "../../src/memory/governance/types.js";
import type { TaskContract } from "../../src/orchestration/index.js";

function mkContract(over: Partial<TaskContract> = {}): TaskContract {
	return {
		taskId: "T-impl-1",
		phase: "P2",
		epicId: "image_upload",
		personaId: "code_executor",
		objective: "implement the upload handler",
		inputs: { userGoal: "image upload", artifacts: [], constraints: [] },
		pathPolicy: { allowedGlobs: ["src/upload.ts"], forbiddenGlobs: [] },
		acceptance: ["accepts a PNG", "rejects >5MB"],
		outputSchema: "task_report",
		parallelGroup: "impl",
		dependsOn: [],
		abortOnConflict: false,
		...over,
	};
}

function mkCandidate(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
	return {
		sourceTask: "T-scout-1",
		persona: "repo_scout",
		scope: "backend",
		confidence: "medium",
		relatedFiles: [],
		body: "Some finding.",
		...over,
	};
}

describe("buildContextPack", () => {
	it("always includes objective and acceptance", () => {
		const pack = buildContextPack({ contract: mkContract(), candidates: [] });
		expect(pack.text).toContain("## Objective");
		expect(pack.text).toContain("implement the upload handler");
		expect(pack.text).toContain("## Acceptance Criteria");
		expect(pack.text).toContain("accepts a PNG");
	});

	it("includes constraints when present", () => {
		const contract = mkContract({
			inputs: { userGoal: "g", artifacts: [], constraints: ["no external deps"] },
		});
		const pack = buildContextPack({ contract, candidates: [] });
		expect(pack.text).toContain("## Constraints");
		expect(pack.text).toContain("no external deps");
	});

	it("omits constraints section when empty", () => {
		const pack = buildContextPack({ contract: mkContract(), candidates: [] });
		expect(pack.text).not.toContain("## Constraints");
	});

	it("includes canonical sections", () => {
		const canonicalSections: CanonicalSection[] = [
			{ key: "architecture", path: ".minimum/architecture.md", body: "Layered MVC." },
		];
		const pack = buildContextPack({ contract: mkContract(), candidates: [], canonicalSections });
		expect(pack.text).toContain("## Project Memory");
		expect(pack.text).toContain("architecture");
		expect(pack.text).toContain("Layered MVC.");
		expect(pack.includedSections).toContain("architecture");
	});

	it("skips empty canonical section bodies", () => {
		const canonicalSections: CanonicalSection[] = [
			{ key: "empty", path: ".minimum/empty.md", body: "   " },
		];
		const pack = buildContextPack({ contract: mkContract(), candidates: [], canonicalSections });
		expect(pack.includedSections).toEqual([]);
	});

	it("includes relevant perception findings", () => {
		const candidates = [
			mkCandidate({ relatedFiles: ["src/upload.ts"], body: "Use multer." }),
		];
		const pack = buildContextPack({ contract: mkContract(), candidates });
		expect(pack.text).toContain("## Perception Findings");
		expect(pack.text).toContain("Use multer.");
		expect(pack.includedCandidates).toContain("T-scout-1.repo_scout");
	});

	it("drops the task's own staged candidate", () => {
		const candidates = [
			mkCandidate({ sourceTask: "T-impl-1", persona: "code_executor", body: "self note" }),
		];
		const pack = buildContextPack({ contract: mkContract(), candidates });
		expect(pack.includedCandidates).toEqual([]);
	});

	it("drops empty-body candidates", () => {
		const candidates = [mkCandidate({ body: "   " })];
		const pack = buildContextPack({ contract: mkContract(), candidates });
		expect(pack.includedCandidates).toEqual([]);
	});

	it("truncates and flags when the token budget is exceeded", () => {
		const big = "x".repeat(8000);
		const candidates = [
			mkCandidate({ sourceTask: "T-a", body: big }),
			mkCandidate({ sourceTask: "T-b", body: big }),
		];
		const pack = buildContextPack({ contract: mkContract(), candidates, maxTokens: 500 });
		expect(pack.truncated).toBe(true);
		expect(pack.includedCandidates.length).toBeLessThan(2);
	});

	it("reports approximate token count", () => {
		const pack = buildContextPack({ contract: mkContract(), candidates: [] });
		expect(pack.approxTokens).toBeGreaterThan(0);
	});

	it("renders module interface contracts for a consumer", () => {
		const contract = mkContract({
			taskId: "T2-be",
			interfaceContracts: [{
				id: "IC-todo", boundary: "api_rpc", schema: "{ Todo: {id,title,done} }",
				rules: ["empty list returns [] not null"],
				bindings: [{ language: "typescript", files: ["src/shared/api.ts"], definition: "export interface Todo {}" }],
				ownerTaskId: "T1-scaffold", consumerTaskIds: ["T2-be"], revision: 1,
			}],
		});
		const pack = buildContextPack({ contract, candidates: [] });
		expect(pack.text).toContain("## Module Interface Contracts");
		expect(pack.text).toContain("IC-todo");
		expect(pack.text).toContain("empty list returns [] not null");
		expect(pack.text).toContain("export interface Todo {}");
		expect(pack.text).toContain("owner: T1-scaffold");
	});

	it("keeps interface contracts even when the budget is tiny", () => {
		const contract = mkContract({
			taskId: "T2-be",
			interfaceContracts: [{
				id: "IC-keep", boundary: "data_schema", schema: "shape", rules: ["r"],
				bindings: [{ language: "python", files: ["shared/contract.py"], definition: "class Todo: ..." }],
				ownerTaskId: "T1", consumerTaskIds: ["T2-be"], revision: 1,
			}],
			inputs: { userGoal: "g", artifacts: [], constraints: [] },
		});
		const candidates = [
			{ sourceTask: "S", persona: "repo_scout", scope: "x", confidence: "high" as const, relatedFiles: [], body: "x".repeat(5000) },
		];
		const pack = buildContextPack({ contract, candidates, maxTokens: 200 });
		expect(pack.text).toContain("IC-keep");
	});
});

describe("rankCandidates", () => {
	it("ranks file-overlapping candidates above non-overlapping ones", () => {
		const contract = mkContract({ pathPolicy: { allowedGlobs: ["src/upload.ts"], forbiddenGlobs: [] } });
		const overlap = mkCandidate({ sourceTask: "T-x", relatedFiles: ["src/upload.ts"], confidence: "low" });
		const noOverlap = mkCandidate({ sourceTask: "T-y", relatedFiles: ["src/other.ts"], confidence: "high" });
		const ranked = rankCandidates([noOverlap, overlap], contract);
		expect(ranked[0]!.sourceTask).toBe("T-x");
	});

	it("breaks ties by confidence then sourceTask", () => {
		const contract = mkContract();
		const hi = mkCandidate({ sourceTask: "T-b", relatedFiles: [], confidence: "high" });
		const lo = mkCandidate({ sourceTask: "T-a", relatedFiles: [], confidence: "low" });
		const ranked = rankCandidates([lo, hi], contract);
		expect(ranked[0]!.sourceTask).toBe("T-b"); // higher confidence wins
	});

	it("supports glob patterns in allowedGlobs", () => {
		const contract = mkContract({ pathPolicy: { allowedGlobs: ["src/**/*.ts"], forbiddenGlobs: [] } });
		const match = mkCandidate({ sourceTask: "T-m", relatedFiles: ["src/api/upload.ts"] });
		const ranked = rankCandidates([match], contract);
		expect(ranked).toHaveLength(1);
	});

	it("normalizes ./-prefixed related paths to match the policy gate", () => {
		const contract = mkContract({ pathPolicy: { allowedGlobs: ["src/upload.ts"], forbiddenGlobs: [] } });
		const dotted = mkCandidate({ sourceTask: "T-d", relatedFiles: ["./src/upload.ts"], confidence: "low" });
		const plain = mkCandidate({ sourceTask: "T-p", relatedFiles: ["unrelated.ts"], confidence: "high" });
		const ranked = rankCandidates([plain, dotted], contract);
		// dotted has file overlap (worth 10) so it must outrank the high-confidence non-overlap
		expect(ranked[0]!.sourceTask).toBe("T-d");
	});
});

describe("writeContextPack", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-ctxpack-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("writes the pack to tasks/<epic>/context-packs/<taskId>.md", async () => {
		const contract = mkContract();
		const { path: written, pack } = await writeContextPack(dir, { contract, candidates: [] });
		const expected = contextPackPath(dir, "image_upload", "T-impl-1");
		expect(written).toBe(expected);
		expect(fs.existsSync(written)).toBe(true);
		const onDisk = fs.readFileSync(written, "utf-8");
		expect(onDisk).toBe(pack.text);
		expect(onDisk).toContain("implement the upload handler");
	});
});
