import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	defaultMemorySectionForCandidate,
	defaultMemoryTargetForCandidate,
	renderEntry,
	score,
	shouldPersist,
	shouldRequireSecondReview,
	upsertSectionInFile,
} from "../governance/index.js";
import { deleteCandidate, writeCandidate } from "../governance/MemoryStaging.js";
import type {
	MemoryCandidate,
	MemoryDecision,
	MemoryScore,
} from "../governance/types.js";

export interface MemoryWriterOptions {
	projectRoot: string;
	memoryRoot?: string;
	now?: Date;
}

export interface WriteMemoryOptions {
	/** Canonical markdown file under memoryRoot; defaults from candidate scope. */
	target?: string;
	/** H2 section in the canonical markdown file. */
	section?: string;
	/** Force a reviewer/operator decision, useful when applying queued staging items. */
	decision?: MemoryDecision;
	/** Human-readable reason stored on review-required staging entries. */
	reason?: string;
}

export interface MemoryWriteResult {
	candidateId: string;
	decision: MemoryDecision;
	score: MemoryScore;
	stagingPath: string;
	canonicalPath?: string;
	archivePath?: string;
	reason: string;
}

/**
 * MemoryWriter implements the single-agent memory write path.
 *
 * Every candidate is persisted to `_staging` before any decision is applied.
 * The deterministic scorer then classifies the candidate as auto-merge,
 * review-required, reject, or archive. Auto-merged entries are appended to
 * canonical markdown with provenance comments; review-required entries remain
 * in `_staging` so `/memory` can surface them.
 */
export class MemoryWriter {
	private readonly projectRoot: string;
	private readonly memoryRoot: string;
	private readonly now?: Date;

	constructor(options: MemoryWriterOptions) {
		this.projectRoot = options.projectRoot;
		this.memoryRoot = options.memoryRoot ?? ".minimum";
		this.now = options.now;
	}

	async write(
		candidate: MemoryCandidate,
		options: WriteMemoryOptions = {},
	): Promise<MemoryWriteResult> {
		const candidateId = `${candidate.sourceTask}.${candidate.persona}`;
		const scored = score(candidate);
		const classification =
			options.decision ?? decideMemory(candidate, scored, options.target);
		const reason =
			options.reason ?? decisionReason(candidate, scored, classification, options.target);
		const stagedCandidate: MemoryCandidate = {
			...candidate,
			decision: classification,
			...(classification === "needs_review" && { reviewReason: reason }),
		};
		const stagingPath = await writeCandidate(
			this.projectRoot,
			stagedCandidate,
			this.memoryRoot,
		);

		switch (classification) {
			case "merge":
			case "update": {
				// NEW: reuse shared routing so single-agent and W4 memory land in the same files.
				const target = options.target ?? defaultMemoryTargetForCandidate(candidate);
				const filePath = path.join(this.projectRoot, this.memoryRoot, target);
				await upsertSectionInFile(
					filePath,
					options.section ?? defaultMemorySectionForCandidate(candidate),
					renderEntry(candidate),
					classification === "update" ? "replace" : "append",
				);
				await deleteCandidate(stagingPath);
				return {
					candidateId,
					decision: classification,
					score: scored,
					stagingPath,
					canonicalPath: filePath,
					reason,
				};
			}
			case "archive": {
				const archivePath = await this.archiveCandidate(candidateId, candidate);
				await deleteCandidate(stagingPath);
				return {
					candidateId,
					decision: classification,
					score: scored,
					stagingPath,
					archivePath,
					reason,
				};
			}
			case "reject":
				await deleteCandidate(stagingPath);
				return { candidateId, decision: classification, score: scored, stagingPath, reason };
			case "needs_review":
				return { candidateId, decision: classification, score: scored, stagingPath, reason };
		}
	}

	private async archiveCandidate(
		candidateId: string,
		candidate: MemoryCandidate,
	): Promise<string> {
		const now = this.now ?? new Date();
		const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
		const dir = path.join(this.projectRoot, this.memoryRoot, "_archive", ym);
		await fs.mkdir(dir, { recursive: true });
		const archivePath = path.join(dir, `${candidateId}.md`);
		await fs.writeFile(
			archivePath,
			`## archived: ${candidateId}\n\n${renderEntry(candidate)}\n`,
			"utf-8",
		);
		return archivePath;
	}
}

export function decideMemory(
	candidate: MemoryCandidate,
	scored = score(candidate),
	target?: string,
): MemoryDecision {
	const body = candidate.body.toLowerCase();
	if (containsAny(body, ARCHIVE_SIGNALS)) return "archive";
	if (isGlobalMemory(candidate, target) && containsAny(body, GLOBAL_REVIEW_SIGNALS)) {
		return "needs_review";
	}
	if (!shouldPersist(scored)) return "reject";
	if (isGlobalMemory(candidate, target)) {
		if (containsAny(body, USER_PREFERENCE_SIGNALS)) return "merge";
		return "needs_review";
	}
	if (shouldRequireSecondReview(scored)) return "needs_review";
	return "merge";
}

function decisionReason(
	candidate: MemoryCandidate,
	scored: MemoryScore,
	decision: MemoryDecision,
	target?: string,
): string {
	if (decision === "archive") {
		return "Candidate describes deprecated or superseded knowledge; archived for history.";
	}
	if (decision === "reject") {
		return `Rejected by scorer (reuse=${scored.reuseValue}, confidence=${scored.confidence}, evidence=${scored.evidence}).`;
	}
	if (decision === "needs_review" && isGlobalMemory(candidate, target)) {
		return "Global memory requires review unless it is a low-risk user preference.";
	}
	if (decision === "needs_review") return "High risk-if-wrong memory requires human review.";
	return "Auto-merged by deterministic memory scorer.";
}

function isGlobalMemory(candidate: MemoryCandidate, target?: string): boolean {
	const scope = candidate.scope.toLowerCase();
	return target === "global.md" || scope.includes("global") || scope.includes("user");
}

function containsAny(body: string, signals: string[]): boolean {
	return signals.some((signal) => body.includes(signal));
}

const USER_PREFERENCE_SIGNALS = [
	"prefer",
	"preference",
	"likes",
	"dislikes",
	"user wants",
	"user prefers",
	"style preference",
];

const GLOBAL_REVIEW_SIGNALS = [
	"credential",
	"password",
	"secret",
	"token",
	"api key",
	"auth",
	"security",
	"safety",
	"identity",
	"passport",
	"ssn",
	"social security",
	"email address",
];

const ARCHIVE_SIGNALS = [
	"archive this",
	"should be archived",
	"deprecated",
	"superseded",
	"obsolete",
	"no longer valid",
];
