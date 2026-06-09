import type { MemoryIndexRefreshScheduler } from "../memory/governance/RefreshScheduler.js";
import { writeCandidate } from "../memory/governance/MemoryStaging.js";
import type { MemoryCandidate, MemoryConfidence } from "../memory/governance/types.js";
import type { Persona, PersonaId } from "../personas/Persona.js";
import { getPersona } from "../personas/PersonaRegistry.js";
import { filterAllowedTools } from "../tools/policy/ToolAllowlistEnforcer.js";
import { validateContract } from "./ContractValidator.js";
import type { TaskContract } from "./TaskContract.js";

export type TaskStatus =
	| "ok"
	| "blocked"
	| "error"
	| "contract_invalid"
	| "degraded"
	| "skipped";

export interface ReadonlyFallbackAccess {
	mode: "readonly_workspace";
	allowed: boolean;
	root: string;
	allowTools: string[];
	denyTools: string[];
	allowFileGlobs: string[];
	denyFileGlobs: string[];
	maxFileBytes: number;
	maxTotalBytes: number;
}

export interface TaskResult {
	taskId: string;
	personaId: PersonaId;
	status: TaskStatus;
	/** Parsed content of the <task_report> block. */
	report: string;
	/** Raw body of the <memory_candidate> block, if the worker emitted one. */
	memoryCandidateBody: string | undefined;
	errors: string[];
	/** Set when staging write succeeds but fails to persist; task status is still valid. */
	stagingError?: string;
	/** True when the worker loop exhausted maxSteps before producing a final answer. */
	hitStepLimit?: boolean;
	/** True when TaskRunner retried once to repair a missing <task_report> envelope. */
	schemaRepairAttempted?: boolean;
	retryCount?: number;
	degradedReason?: string;
	skipReason?: string;
	lastError?: string;
	fallbackAccess?: ReadonlyFallbackAccess;
	durationMs: number;
}

export interface SchemaRepairRequest {
	feedback: string;
	rawOutput: string;
	attempt: number;
}

export interface WorkerExecutionResult {
	text: string;
	hitStepLimit?: boolean;
	/** True when the model stream ended with no content and no tool calls. */
	emptyFinalTurn?: boolean;
	/** Structured terminal reason surfaced by worker/client adapters. */
	finishReason?: "final" | "empty_stream" | "step_limit";
	attempt?: number;
}

/** Worker run mode: a `plan` turn is read-only and must emit <execution_plan>;
 *  `execute` (default) performs the task and emits <task_report>. */
export type WorkerRunMode = "plan" | "execute";

/** Injectable worker executor; real impl calls the LLM, tests may still return plain text. */
export interface WorkerExecutor {
	run(
		contract: TaskContract,
		filteredTools: string[],
		repair?: SchemaRepairRequest,
		runOpts?: { mode?: WorkerRunMode; signal?: AbortSignal },
	): Promise<string | WorkerExecutionResult>;
}

export interface TaskRunnerOptions {
	projectRoot: string;
	executor: WorkerExecutor;
	refreshScheduler?: MemoryIndexRefreshScheduler;
	retryBackoff?: Partial<RetryBackoffOptions>;
	signal?: AbortSignal;
}

interface RetryBackoffOptions {
	baseDelayMs: number;
	maxDelayMs: number;
	random: () => number;
	sleep: (ms: number) => Promise<void>;
}

const READONLY_FALLBACK_ALLOW_TOOLS = [
	"read_file",
	"list_directory",
	"grep",
	"glob",
	"git_status",
	"git_log",
	"git_diff",
	"shell_fs_read",
	"shell_search",
	"shell_git_read",
] as const;

const READONLY_FALLBACK_DENY_TOOLS = [
	"write_file",
	"edit_file",
	"apply_patch",
	"exec_shell",
	"shell_raw",
	"install_dependency",
	"web_fetch",
	"git",
] as const;

export const RETRYABLE_SCAN_ATTEMPTS = 5;
export const RETRYABLE_WORKER_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 500;
const DEFAULT_RETRY_BACKOFF_CAP_MS = 8_000;

/**
 * Run a single contracted task end-to-end.
 *
 * Pipeline:
 *   1. Validate contract and abort with contract_invalid if invalid.
 *   2. Filter tools to the persona's effective allowlist.
 *   3. Execute via the injected WorkerExecutor.
 *   4. Parse <task_report> and optional <memory_candidate> from output.
 *   5. Retry once if the worker omitted the required <task_report> envelope.
 *   6. If a candidate was emitted, persist it to _staging/.
 */
export async function runTask(
	contract: TaskContract,
	opts: TaskRunnerOptions,
): Promise<TaskResult> {
	const start = Date.now();
	const base = { taskId: contract.taskId, personaId: contract.personaId };

	const validation = validateContract(contract);
	if (!validation.ok) {
		return {
			...base,
			status: "contract_invalid",
			report: "",
			memoryCandidateBody: undefined,
			errors: validation.errors,
			durationMs: Date.now() - start,
		};
	}

	const persona = getPersona(contract.personaId);
	const filteredTools = filterAllowedTools(persona.toolAllowlist, persona);

	if (opts.signal?.aborted) {
		return {
			...base,
			status: "skipped",
			report: "<status>skipped</status><summary>Aborted before execution</summary>",
			memoryCandidateBody: undefined,
			errors: ["aborted"],
			skipReason: "aborted",
			durationMs: Date.now() - start,
		};
	}

	let execution: WorkerExecutionResult;
	try {
		execution = normalizeWorkerExecution(
			await opts.executor.run(contract, filteredTools, undefined, { signal: opts.signal }),
		);
	} catch (err: unknown) {
		return {
			...base,
			status: "error",
			report: "",
			memoryCandidateBody: undefined,
			errors: [err instanceof Error ? err.message : String(err)],
			durationMs: Date.now() - start,
		};
	}

	let rawOutput = execution.text;
	let reportInspection = inspectXmlBlock(rawOutput, "task_report");
	let report = reportInspection.content;
	let memBlock = extractXmlBlock(rawOutput, "memory_candidate") || undefined;
	let status = detectStatus(report);
	let missingBlocks = findMissingReportBlocks(report, status, persona);
	let schemaRepairAttempted = false;
	const attempts: MissingReportAttempt[] = [
		buildMissingReportAttempt("initial", rawOutput, execution, reportInspection),
	];

	// One repair round covers two cases: a missing/malformed <task_report>
	// envelope, or a completed report that omits a persona-required sub-block
	// (e.g. repo_scout without <file_list>). Both feed back a targeted re-emit
	// request asking only for the missing piece, then re-validate once.
	if (!report || missingBlocks.length > 0) {
		schemaRepairAttempted = true;
		const repair = report
			? buildBlockRepairRequest(rawOutput, missingBlocks)
			: buildSchemaRepairRequest(
				rawOutput,
				execution,
				reportInspection.diagnostics,
			);
		try {
			execution = normalizeWorkerExecution(
				await opts.executor.run(contract, filteredTools, repair, { signal: opts.signal }),
			);
			rawOutput = execution.text;
			reportInspection = inspectXmlBlock(rawOutput, "task_report");
			report = reportInspection.content;
			memBlock = extractXmlBlock(rawOutput, "memory_candidate") || undefined;
			status = detectStatus(report);
			missingBlocks = findMissingReportBlocks(report, status, persona);
			attempts.push(buildMissingReportAttempt("repair", rawOutput, execution, reportInspection));
		} catch (err: unknown) {
			const repairError = err instanceof Error ? err.message : String(err);
			return {
				...base,
				status: "error",
				report: "",
				memoryCandidateBody: undefined,
				errors: [
					`schema repair retry failed: ${repairError}`,
					...buildMissingReportErrors(attempts, { schemaRepairAttempted }),
				],
				hitStepLimit: execution.hitStepLimit,
				schemaRepairAttempted,
				durationMs: Date.now() - start,
			};
		}
	}

	let stagingError: string | undefined;
	if (memBlock) {
		const candidate = parseMemoryCandidate(memBlock, contract);
		try {
			await writeCandidate(opts.projectRoot, candidate);
			opts.refreshScheduler?.markDirty("task:memoryCandidate");
		} catch (err) {
			stagingError = err instanceof Error ? err.message : String(err);
		}
	}

	const errors = report
		? []
		: buildMissingReportErrors(attempts, { schemaRepairAttempted });

	return {
		...base,
		status,
		report,
		memoryCandidateBody: memBlock,
		errors,
		...(stagingError !== undefined && { stagingError }),
		...(execution.hitStepLimit !== undefined && { hitStepLimit: execution.hitStepLimit }),
		...(schemaRepairAttempted && { schemaRepairAttempted }),
		durationMs: Date.now() - start,
	};
}

export async function runTaskWithRetry(
	contract: TaskContract,
	opts: TaskRunnerOptions,
): Promise<TaskResult> {
	const start = Date.now();
	const maxAttempts = contract.personaId === "repo_scout"
		? RETRYABLE_SCAN_ATTEMPTS
		: RETRYABLE_WORKER_ATTEMPTS;
	let lastResult: TaskResult | undefined;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (opts.signal?.aborted) break;
		const result = await runTask(contract, opts);
		lastResult = result;
		if (!shouldRetryTaskResult(result)) {
			return attempt === 1 ? result : { ...result, retryCount: attempt - 1 };
		}
		if (attempt < maxAttempts) {
			if (opts.signal?.aborted) break;
			await waitForRetryBackoff(attempt, opts.retryBackoff);
			continue;
		}
	}

	const retryCount = Math.max(0, maxAttempts - 1);
	const lastError = summarizeRetryError(lastResult);
	if (contract.personaId === "repo_scout") {
		const degradedReason = `repo_scout scan failed after ${maxAttempts} retryable attempt(s)`;
		return {
			taskId: contract.taskId,
			personaId: contract.personaId,
			status: "degraded",
			report: buildDegradedScanReport(degradedReason, lastError),
			memoryCandidateBody: undefined,
			errors: [degradedReason, ...(lastError ? [`last error: ${lastError}`] : [])],
			retryCount,
			degradedReason,
			...(lastError && { lastError }),
			fallbackAccess: buildReadonlyFallbackAccess(opts.projectRoot),
			durationMs: Date.now() - start,
		};
	}

	const skipReason = `task skipped after ${maxAttempts} retryable attempt(s)`;
	return {
		taskId: contract.taskId,
		personaId: contract.personaId,
		status: "skipped",
		report: buildSkippedReport(skipReason, lastError),
		memoryCandidateBody: undefined,
		errors: [skipReason, ...(lastError ? [`last error: ${lastError}`] : [])],
		retryCount,
		skipReason,
		...(lastError && { lastError }),
		durationMs: Date.now() - start,
	};
}

export function buildReadonlyFallbackAccess(root: string): ReadonlyFallbackAccess {
	return {
		mode: "readonly_workspace",
		allowed: true,
		root,
		allowTools: [...READONLY_FALLBACK_ALLOW_TOOLS],
		denyTools: [...READONLY_FALLBACK_DENY_TOOLS],
		allowFileGlobs: [
			"**/*.ts",
			"**/*.tsx",
			"**/*.js",
			"**/*.jsx",
			"**/*.json",
			"**/*.md",
			"**/*.yaml",
			"**/*.yml",
			"**/*.toml",
		],
		denyFileGlobs: [
			"**/.env",
			"**/.env.*",
			"**/secrets/**",
			"**/.ssh/**",
			"**/node_modules/**",
			"**/.git/objects/**",
		],
		maxFileBytes: 512_000,
		maxTotalBytes: 20_000_000,
	};
}

function shouldRetryTaskResult(result: TaskResult): boolean {
	if (result.status !== "error") return false;
	const text = `${result.report}\n${result.errors.join("\n")}`.toLowerCase();
	if (isNonRetryableErrorText(text)) return false;
	return isRetryableErrorText(text);
}

function isRetryableErrorText(text: string): boolean {
	return [
		/\btimeout\b/,
		/timed out/,
		/rate[_\s-]?limit/,
		/rate limited/,
		/rate-limited/,
		/\b429\b/,
		/network[_\s-]?error/,
		/\bnetwork\b/,
		/econnreset/,
		/etimedout/,
		/econnrefused/,
		/api[_\s-]?5xx/,
		/\b50[0234]\b/,
		/tool[_\s-]?unavailable/,
		/unavailable/,
		/empty[_\s-]?response/,
		/empty stream/,
		/empty output/,
		/no output/,
		/malformed[_\s-]?tool[_\s-]?response/,
		/malformed tool/,
		/maxsteps/,
		/max steps/,
		/step limit/,
	].some((pattern) => pattern.test(text));
}

function isNonRetryableErrorText(text: string): boolean {
	return [
		/permission[_\s-]?denied/,
		/access denied/,
		/workspace[_\s-]?not[_\s-]?found/,
		/invalid[_\s-]?contract/,
		/schema[_\s-]?validation[_\s-]?failed/,
		/user[_\s-]?cancelled/,
		/user canceled/,
		/tool[_\s-]?denied/,
		/blocked_path_violation/,
		/path violation/,
		/policy violation/,
		/safety denial/,
		/not in .* allowlist/,
		/in .* denylist/,
	].some((pattern) => pattern.test(text));
}

function summarizeRetryError(result: TaskResult | undefined): string {
	if (!result) return "";
	const text = result.errors.length ? result.errors.join("; ") : result.report;
	return summarizeRawOutput(text);
}

function buildDegradedScanReport(reason: string, lastError: string): string {
	return [
		"<status>degraded</status>",
		`<summary>${escapeXml(reason)}.</summary>`,
		"<fallback_access>",
		"mode: readonly_workspace",
		"allowed: true",
		"</fallback_access>",
		"<missing_outputs>",
		"- file_list",
		"- relevant_files",
		"- tech_stack",
		"- test_commands",
		"- static_compile_commands",
		"</missing_outputs>",
		lastError ? `<last_error>${escapeXml(lastError)}</last_error>` : "",
	].filter(Boolean).join("\n");
}

function buildSkippedReport(reason: string, lastError: string): string {
	return [
		"<status>skipped</status>",
		`<summary>${escapeXml(reason)}.</summary>`,
		lastError ? `<last_error>${escapeXml(lastError)}</last_error>` : "",
	].filter(Boolean).join("\n");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function normalizeWorkerExecution(
	output: string | WorkerExecutionResult,
): WorkerExecutionResult {
	if (typeof output === "string") return { text: output };
	return output;
}

function resolveRetryBackoff(
	overrides?: Partial<RetryBackoffOptions>,
): RetryBackoffOptions {
	return {
		baseDelayMs: overrides?.baseDelayMs ?? DEFAULT_RETRY_BACKOFF_MS,
		maxDelayMs: overrides?.maxDelayMs ?? DEFAULT_RETRY_BACKOFF_CAP_MS,
		random: overrides?.random ?? Math.random,
		sleep: overrides?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
	};
}

function computeRetryBackoffMs(
	attempt: number,
	overrides?: Partial<RetryBackoffOptions>,
): number {
	const config = resolveRetryBackoff(overrides);
	const cap = Math.min(
		config.maxDelayMs,
		config.baseDelayMs * 2 ** Math.max(0, attempt - 1),
	);
	return Math.max(0, Math.round(cap * clampUnitInterval(config.random())));
}

async function waitForRetryBackoff(
	attempt: number,
	overrides?: Partial<RetryBackoffOptions>,
): Promise<void> {
	const config = resolveRetryBackoff(overrides);
	const delayMs = computeRetryBackoffMs(attempt, config);
	if (delayMs <= 0) return;
	await config.sleep(delayMs);
}

function clampUnitInterval(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
}

function buildSchemaRepairRequest(
	rawOutput: string,
	execution: WorkerExecutionResult,
	diagnostics: string[],
): SchemaRepairRequest {
	const excerpt = summarizeRawOutput(rawOutput.trim()) || "(empty)";
	const prefix = execution.hitStepLimit || execution.finishReason === "step_limit"
		? "Previous attempt hit the worker step limit before producing a valid <task_report>."
		: execution.emptyFinalTurn || execution.finishReason === "empty_stream"
			? "Previous attempt ended with an empty final worker turn."
		: "Previous attempt did not produce a valid <task_report>.";
	const diagnosticText = diagnostics.length
		? `\nParser diagnostics: ${diagnostics.join("; ")}`
		: "";
	return {
		attempt: 2,
		rawOutput,
		feedback: [
			`${prefix}${diagnosticText}`,
			"Do not continue analysis or expand scope.",
			"Re-emit the smallest valid final response as one <task_report> block only.",
			"Do not include <memory_candidate> during schema repair.",
			"No prose before or after the XML block.",
			"Required shape:",
			"<task_report>",
			"  <status>completed | blocked | failed</status>",
			"  <summary>Reuse only facts already gathered.</summary>",
			"</task_report>",
			`Raw excerpt: ${excerpt}`,
		].join("\n"),
	};
}

/**
 * Required sub-blocks a completed report omitted. Only enforced for an "ok"
 * (completed) report — a blocked/failed/degraded/skipped report legitimately
 * drops deliverable blocks, and a missing envelope is handled separately.
 */
function findMissingReportBlocks(
	report: string,
	status: TaskStatus,
	persona: Persona,
): string[] {
	if (!report || status !== "ok") return [];
	const required = persona.requiredReportBlocks ?? [];
	if (required.length === 0) return [];
	return required.filter((tag) => !inspectXmlBlock(report, tag).content);
}

/**
 * Targeted re-emit request for a report that parsed but is missing one or more
 * persona-required sub-blocks. Asks the worker to keep everything it already
 * produced and only add the named block(s).
 */
function buildBlockRepairRequest(
	rawOutput: string,
	missingBlocks: string[],
): SchemaRepairRequest {
	const excerpt = summarizeRawOutput(rawOutput.trim()) || "(empty)";
	const blockList = missingBlocks.map((b) => `<${b}>`).join(", ");
	return {
		attempt: 2,
		rawOutput,
		feedback: [
			`Your <task_report> parsed but is missing required block(s): ${blockList}.`,
			"Re-emit the COMPLETE <task_report> with the SAME content you already produced, adding only the missing block(s) above.",
			"Do not drop any block you already included. Do not include <memory_candidate> during this repair.",
			"No prose before or after the XML block.",
			`Raw excerpt: ${excerpt}`,
		].join("\n"),
	};
}

function buildMissingReportErrors(
	attempts: MissingReportAttempt[],
	opts: { schemaRepairAttempted?: boolean },
): string[] {
	const errors: string[] = [];
	const finalAttempt = attempts[attempts.length - 1];
	const allEmpty = attempts.every((a) => !a.rawOutput.trim());
	if (allEmpty) {
		errors.push("worker returned empty output - no <task_report> block was emitted");
	} else if (attempts.some((a) => a.hitStepLimit || a.finishReason === "step_limit")) {
		errors.push("worker hit maxSteps before emitting a <task_report> block");
	} else if (finalAttempt?.emptyFinalTurn || finalAttempt?.finishReason === "empty_stream") {
		errors.push("worker stream ended with an empty final turn - no <task_report> block was emitted");
	} else {
		errors.push("worker output did not contain a <task_report> block; the model likely responded outside the required schema");
	}
	if (opts.schemaRepairAttempted) {
		errors.push("schema repair retry was attempted once and still did not produce a valid <task_report>");
	}
	for (const attempt of attempts) {
		for (const diagnostic of attempt.diagnostics) {
			errors.push(`${attempt.label} parse: ${diagnostic}`);
		}
		if (attempt.emptyFinalTurn) errors.push(`${attempt.label} finish: empty final turn`);
		if (attempt.finishReason) errors.push(`${attempt.label} finish_reason: ${attempt.finishReason}`);
		const excerpt = summarizeRawOutput(attempt.rawOutput.trim());
		if (excerpt) errors.push(`${attempt.label} raw excerpt: ${excerpt}`);
	}
	return errors;
}

function summarizeRawOutput(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= 240) return collapsed;
	return `${collapsed.slice(0, 240)}...`;
}

/** Extract the trimmed content between <tag> and </tag>; returns "" if absent. */
export function extractXmlBlock(text: string, tag: string): string {
	return inspectXmlBlock(text, tag).content;
}

interface XmlBlockInspection {
	content: string;
	diagnostics: string[];
}

interface MissingReportAttempt extends WorkerExecutionResult {
	label: "initial" | "repair";
	rawOutput: string;
	diagnostics: string[];
}

function buildMissingReportAttempt(
	label: "initial" | "repair",
	rawOutput: string,
	execution: WorkerExecutionResult,
	inspection: XmlBlockInspection,
): MissingReportAttempt {
	return {
		...execution,
		label,
		rawOutput,
		diagnostics: inspection.diagnostics,
	};
}

function inspectXmlBlock(text: string, tag: string): XmlBlockInspection {
	const trimmed = text.trim();
	if (!trimmed) {
		return { content: "", diagnostics: [`${tag}: output is empty`] };
	}

	const tagName = escapeRegExp(tag);
	const openRe = new RegExp(`<\\s*${tagName}(?:\\s[^>]*)?>`, "i");
	const open = openRe.exec(text);
	if (!open || open.index === undefined) {
		return { content: "", diagnostics: [`${tag}: opening tag not found`] };
	}

	const closeRe = new RegExp(`<\\/\\s*${tagName}\\s*>`, "i");
	const bodyStart = open.index + open[0].length;
	const rest = text.slice(bodyStart);
	const close = closeRe.exec(rest);
	if (!close || close.index === undefined) {
		return { content: "", diagnostics: [`${tag}: opening tag found but closing tag is missing`] };
	}

	const content = rest.slice(0, close.index).trim();
	if (!content) {
		return { content: "", diagnostics: [`${tag}: block content is empty`] };
	}
	return { content, diagnostics: [] };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectStatus(report: string): TaskStatus {
	if (!report) return "error";
	if (/<status>\s*blocked\s*<\/status>/i.test(report)) return "blocked";
	if (/<status>\s*degraded\s*<\/status>/i.test(report)) return "degraded";
	if (/<status>\s*skipped\s*<\/status>/i.test(report)) return "skipped";
	if (/<status>\s*(failed?|error)\s*<\/status>/i.test(report)) return "error";
	return "ok";
}

/**
 * Parse lightweight frontmatter from a <memory_candidate> body:
 *   scope: architecture
 *   confidence: high
 *   related_files:
 *     - src/a.ts
 *   (blank line)
 *   ## Markdown body
 */
function parseMemoryCandidate(
	raw: string,
	contract: TaskContract,
): MemoryCandidate {
	const lines = raw.split("\n");
	let scope = "general";
	let confidence: MemoryConfidence = "medium";
	const relatedFiles: string[] = [];
	let bodyStart = lines.length;
	let inFiles = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === "") {
			bodyStart = i + 1;
			break;
		}
		const scopeM = /^scope:\s*(.+)$/.exec(line);
		if (scopeM) {
			scope = scopeM[1]!.trim();
			inFiles = false;
			continue;
		}
		const confM = /^confidence:\s*(.+)$/.exec(line);
		if (confM) {
			const c = confM[1]!.trim().toLowerCase();
			if (c === "high" || c === "medium" || c === "low") confidence = c;
			inFiles = false;
			continue;
		}
		if (/^related_files:/.test(line)) {
			inFiles = true;
			continue;
		}
		const fileM = /^\s+-\s+(.+)$/.exec(line);
		if (inFiles && fileM) {
			relatedFiles.push(fileM[1]!.trim());
			continue;
		}
		inFiles = false;
	}

	return {
		sourceTask: contract.taskId,
		persona: contract.personaId,
		scope,
		confidence,
		relatedFiles,
		body: lines.slice(bodyStart).join("\n").trim(),
	};
}
