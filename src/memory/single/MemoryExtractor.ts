import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatMessage } from "../../types/common.js";
import { ensureStagingDir } from "../governance/MemoryStaging.js";
import type { MemoryConfidence } from "../governance/types.js";

export type ExtractedMemoryLayer = "project" | "global";

export type ExtractedMemoryCategory =
	| "command"
	| "constraint"
	| "decision"
	| "file_fact"
	| "user_preference";

export interface ExtractedMemoryCandidate {
	id: string;
	layer: ExtractedMemoryLayer;
	category: ExtractedMemoryCategory;
	content: string;
	confidence: MemoryConfidence;
	relatedFiles: string[];
	sourceRole: string;
	sourcePath?: string;
}

export interface MemoryExtractorContext {
	/** Repository root used to persist candidates under `<memoryRoot>/_staging`. */
	projectRoot: string;
	/** Memory root relative to projectRoot. Defaults to `.minimum`. */
	memoryRoot?: string;
	/** Stable prefix for staged candidates. Defaults to `single`. */
	sourceTask?: string;
	/** Optional per-turn identifier used to avoid overwriting prior extractions. */
	turnId?: string;
}

interface PatternMatch {
	category: ExtractedMemoryCategory;
	content: string;
	relatedFiles: string[];
}

const MEMORY_EXTRACTOR_PERSONA = "context_builder";
const MAX_CONTENT_LENGTH = 500;

const COMMAND_PATTERNS: RegExp[] = [
	/(?:本项目|项目|repo|repository).{0,24}(?:测试命令|test command|测试|tests?)\s*(?:是|为|:|=)\s*([^。\n]+)/giu,
	/(?:命令|command)\s*(?:是|为|:|=)\s*([^。\n]+)/giu,
	/`((?:npm|pnpm|yarn|bun|cargo|go|pytest|python|node|vitest|npx)\s+[^`\n]+)`/giu,
];

const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN\s+(?:RSA\s+|DSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/iu,
	/\b(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd)\b\s*[:=]\s*[^\s'"`]+/iu,
	/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/u,
	/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
	/\b[A-Za-z0-9_=-]{24,}\.[A-Za-z0-9_=-]{12,}\.[A-Za-z0-9_=-]{12,}\b/u,
];

const FILE_PATH_PATTERN =
	/(?:^|[\s`'"(])((?:\.?\.?\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|yml|yaml|toml|rs|go|py|java|kt|swift|c|cpp|h|hpp|sh|sql))(?:$|[\s`'"),.:;])/gu;

/**
 * Extract durable memory candidates from the current turn and persist them to
 * the staging area only. Canonical memory is intentionally left untouched.
 */
export async function extractCandidates(
	messages: ChatMessage[],
	context: MemoryExtractorContext,
): Promise<ExtractedMemoryCandidate[]> {
	const candidates: ExtractedMemoryCandidate[] = [];
	let ordinal = 0;

	for (const message of messages) {
		if (!shouldReadMessage(message)) continue;
		const content = stripReasoningContent(message.content);
		if (!content.trim() || containsSecret(content)) continue;

		for (const match of extractFromText(content)) {
			if (containsSecret(match.content)) continue;
			const layer = classifyLayer(match);
			const id = buildCandidateId(context, ++ordinal);
			candidates.push({
				id,
				layer,
				category: match.category,
				content: normalizeContent(match.content),
				confidence: "medium",
				relatedFiles: match.relatedFiles,
				sourceRole: message.role,
			});
		}
	}

	await writeStagedCandidates(context, candidates);
	return candidates;
}

function shouldReadMessage(message: ChatMessage): boolean {
	if (!["user", "assistant", "tool"].includes(message.role)) return false;
	// We intentionally do not read `reasoning_content`; only user-visible content
	// participates in extraction.
	return true;
}

function stripReasoningContent(content: string): string {
	return content
		.replace(/<reasoning>[\s\S]*?<\/reasoning>/giu, "")
		.replace(/<think>[\s\S]*?<\/think>/giu, "")
		.replace(/```reasoning[\s\S]*?```/giu, "")
		.replace(/```thinking[\s\S]*?```/giu, "");
}

function extractFromText(text: string): PatternMatch[] {
	const lines = text.split(/\r?\n/).flatMap((line) => splitSentences(line));
	const out: PatternMatch[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || containsSecret(line)) continue;
		out.push(...extractCommands(line));
		const files = extractRelatedFiles(line);
		if (isUserPreference(line)) {
			out.push({ category: "user_preference", content: line, relatedFiles: [] });
		}
		if (isConstraint(line)) {
			out.push({ category: "constraint", content: line, relatedFiles: files });
		}
		if (isDecision(line)) {
			out.push({ category: "decision", content: line, relatedFiles: files });
		}
		if (files.length > 0 && isFileFact(line)) {
			out.push({ category: "file_fact", content: line, relatedFiles: files });
		}
	}
	return dedupeMatches(out);
}

function splitSentences(line: string): string[] {
	return line
		.split(/(?<=[。！？!?])\s+|[；;]/u)
		.map((part) => part.trim())
		.filter(Boolean);
}

function extractCommands(line: string): PatternMatch[] {
	const out: PatternMatch[] = [];
	for (const pattern of COMMAND_PATTERNS) {
		pattern.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = pattern.exec(line))) {
			const command = (m[1] ?? m[0] ?? "").trim();
			if (!command || containsSecret(command)) continue;
			out.push({ category: "command", content: line, relatedFiles: extractRelatedFiles(line) });
		}
	}
	return out;
}

function isUserPreference(line: string): boolean {
	return /(?:以后|之后|今后).{0,12}(?:回答|回复|输出).{0,12}(?:中文|英文|简洁|详细)|(?:always|please|prefer).{0,32}(?:respond|answer|reply|write).{0,32}(?:Chinese|English|concise|detailed)/iu.test(
		line,
	);
}

function isConstraint(line: string): boolean {
	return /(?:必须|不要|不能|禁止|只允许|需要遵守|约束|限制|务必|不得|always|never|must|must not|do not|don't|only allow|constraint|requirement)/iu.test(
		line,
	);
}

function isDecision(line: string): boolean {
	return /(?:决定|选用|采用|统一使用|改为使用|decision|decided|choose|chosen|use|standardize on)/iu.test(
		line,
	);
}

function isFileFact(line: string): boolean {
	return /(?:文件|目录|位于|入口|配置|实现|包含|导出|依赖|架构|module|file|directory|path|entry|config|exports?|contains?|implements?|depends?)/iu.test(
		line,
	);
}

function extractRelatedFiles(text: string): string[] {
	const files = new Set<string>();
	let m: RegExpExecArray | null;
	FILE_PATH_PATTERN.lastIndex = 0;
	while ((m = FILE_PATH_PATTERN.exec(text))) {
		files.add(m[1]!.replace(/^\.\//, ""));
	}
	return [...files];
}

function classifyLayer(match: PatternMatch): ExtractedMemoryLayer {
	if (match.category === "user_preference" && match.relatedFiles.length === 0) return "global";
	return "project";
}

function containsSecret(text: string): boolean {
	return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizeContent(text: string): string {
	const oneLine = text.replace(/\s+/gu, " ").trim();
	return oneLine.length > MAX_CONTENT_LENGTH
		? `${oneLine.slice(0, MAX_CONTENT_LENGTH - 1)}…`
		: oneLine;
}

function dedupeMatches(matches: PatternMatch[]): PatternMatch[] {
	const seen = new Set<string>();
	const out: PatternMatch[] = [];
	for (const match of matches) {
		const key = `${match.category}\0${normalizeContent(match.content)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ ...match, content: normalizeContent(match.content) });
	}
	return out;
}

function buildCandidateId(context: MemoryExtractorContext, ordinal: number): string {
	const task = sanitizeId(context.sourceTask || "single");
	const turn = context.turnId ? `.${sanitizeId(context.turnId)}` : "";
	return `${task}${turn}.${String(ordinal).padStart(3, "0")}`;
}

async function writeStagedCandidates(
	context: MemoryExtractorContext,
	candidates: ExtractedMemoryCandidate[],
): Promise<void> {
	if (candidates.length === 0) return;
	const dir = await ensureStagingDir(context.projectRoot, context.memoryRoot);
	for (const candidate of candidates) {
		const file = path.join(
			dir,
			`${candidate.id}.${MEMORY_EXTRACTOR_PERSONA}.memory.md`,
		);
		await fs.writeFile(file, serializeExtractedCandidate(candidate), "utf-8");
		candidate.sourcePath = file;
	}
}

function serializeExtractedCandidate(candidate: ExtractedMemoryCandidate): string {
	const relatedLines =
		candidate.relatedFiles.length > 0
			? ["related_files:", ...candidate.relatedFiles.map((file) => `  - ${file}`)]
			: ["related_files: []"];
	return [
		"---",
		`source_task: ${candidate.id}`,
		`persona: ${MEMORY_EXTRACTOR_PERSONA}`,
		`scope: ${candidate.layer}`,
		`layer: ${candidate.layer}`,
		`category: ${candidate.category}`,
		`confidence: ${candidate.confidence}`,
		...relatedLines,
		"---",
		"",
		`## ${candidate.category}`,
		`- layer: ${candidate.layer}`,
		`- source_role: ${candidate.sourceRole}`,
		`- content: ${candidate.content}`,
		"",
	].join("\n");
}

function sanitizeId(id: string): string {
	return (
		id.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^\.+/, "_").slice(0, 80) ||
		"single"
	);
}
