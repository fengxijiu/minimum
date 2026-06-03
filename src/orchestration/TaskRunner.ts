import { refreshMemoryIndex } from "../memory/governance/MemoryIndex.js";
import { writeCandidate } from "../memory/governance/MemoryStaging.js";
import type { MemoryCandidate, MemoryConfidence } from "../memory/governance/types.js";
import type { PersonaId } from "../personas/Persona.js";
import { getPersona } from "../personas/PersonaRegistry.js";
import { filterAllowedTools } from "../tools/policy/ToolAllowlistEnforcer.js";
import { validateContract } from "./ContractValidator.js";
import type { TaskContract } from "./TaskContract.js";

export type TaskStatus = "ok" | "blocked" | "error" | "contract_invalid";

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

/** Injectable worker executor; real impl calls the LLM, tests may still return plain text. */
export interface WorkerExecutor {
	run(
		contract: TaskContract,
		filteredTools: string[],
		repair?: SchemaRepairRequest,
	): Promise<string | WorkerExecutionResult>;
}

export interface TaskRunnerOptions {
	projectRoot: string;
	executor: WorkerExecutor;
}

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

	let execution: WorkerExecutionResult;
	try {
		execution = normalizeWorkerExecution(
			await opts.executor.run(contract, filteredTools),
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
	let schemaRepairAttempted = false;
	const attempts: MissingReportAttempt[] = [
		buildMissingReportAttempt("initial", rawOutput, execution, reportInspection),
	];

	if (!report) {
		schemaRepairAttempted = true;
		const repair = buildSchemaRepairRequest(
			rawOutput,
			execution,
			reportInspection.diagnostics,
		);
		try {
			execution = normalizeWorkerExecution(
				await opts.executor.run(contract, filteredTools, repair),
			);
			rawOutput = execution.text;
			reportInspection = inspectXmlBlock(rawOutput, "task_report");
			report = reportInspection.content;
			memBlock = extractXmlBlock(rawOutput, "memory_candidate") || undefined;
			status = detectStatus(report);
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
			await refreshMemoryIndex(opts.projectRoot);
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

function normalizeWorkerExecution(
	output: string | WorkerExecutionResult,
): WorkerExecutionResult {
	if (typeof output === "string") return { text: output };
	return output;
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
