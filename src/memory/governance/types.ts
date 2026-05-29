import type { PersonaId } from "../../personas/Persona.js";

/**
 * MemoryCandidate — a single staging-area memory file's parsed content.
 *
 * Workers emit one inside the `<memory_candidate>` XML block at the end of
 * their final turn. TaskRunner parses the block, writes the raw markdown to
 * .minimum/_staging/<taskId>.<persona>.memory.md, and later MemoryGovernor
 * reads them back during W4 finalize.
 */
export interface MemoryCandidate {
	/** taskId from the originating Task Contract. */
	sourceTask: string;
	/** Which persona produced this candidate. */
	persona: PersonaId;
	/** Scope tag, e.g. "frontend/upload" or "none" for empty bodies. */
	scope: string;
	/** Worker's self-rated confidence. */
	confidence: MemoryConfidence;
	/** Repo-relative file paths the observations relate to. */
	relatedFiles: string[];
	/** Free-form markdown body (after frontmatter). */
	body: string;
	/** Filesystem path the candidate was loaded from (if any). */
	sourcePath?: string;
}

export type MemoryConfidence = "high" | "medium" | "low";

/** Five-dimensional score used by MemoryScorer to gate persistence. */
export interface MemoryScore {
	reuseValue: number;
	confidence: number;
	evidence: number;
	stability: number;
	riskIfWrong: number;
}

/** Master_planner's W4 decision per candidate. */
export type MergeAction = "merge" | "update" | "archive" | "reject";

export interface MergeDecision {
	candidateId: string; // "<sourceTask>.<persona>"
	action: MergeAction;
	/** Canonical filename without leading .minimum/ (e.g. "architecture.md"). */
	target?: string;
	/** H2/H3 section name within the target file. */
	section?: string;
	/** Master's reason for the decision; surfaced in TUI. */
	reason: string;
}

/** What MemoryManifest exposes to the rest of the system. */
export interface Manifest {
	version: number;
	memoryRoot: string;
	canonicalFiles: Record<string, string>;
	staging: { path: string; pattern: string };
	loadPolicy: Record<string, string[]>;
	rules: ManifestRules;
}

export interface ManifestRules {
	subagentsCanWriteStaging: boolean;
	subagentsCanWriteCanonical: boolean;
	mainAgentMergesMemory: boolean;
	requireEvidenceForMemory: boolean;
	archiveDeprecatedMemory: boolean;
}
