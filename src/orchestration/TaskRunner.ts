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
	let report = extractXmlBlock(rawOutput, "task_report");
	let memBlock = extractXmlBlock(rawOutput, "memory_candidate") || undefined;
	let status = detectStatus(report);
	let schemaRepairAttempted = false;

	if (!report) {
		schemaRepairAttempted = true;
		const repair = buildSchemaRepairRequest(rawOutput, execution.hitStepLimit);
		try {
			execution = normalizeWorkerExecution(
				await opts.executor.run(contract, filteredTools, repair),
			);
			rawOutput = execution.text;
			report = extractXmlBlock(rawOutput, "task_report");
			memBlock = extractXmlBlock(rawOutput, "memory_candidate") || undefined;
			status = detectStatus(report);
		} catch (err: unknown) {
			return {
				...base,
				status: "error",
				report: "",
				memoryCandidateBody: undefined,
				errors: [err instanceof Error ? err.message : String(err)],
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
		: buildMissingReportErrors(rawOutput, {
			hitStepLimit: execution.hitStepLimit,
			schemaRepairAttempted,
		});

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
	hitStepLimit: boolean | undefined,
): SchemaRepairRequest {
	const excerpt = summarizeRawOutput(rawOutput.trim()) || "(empty)";
	const prefix = hitStepLimit
		? "Previous attempt hit the worker step limit before producing a valid <task_report>."
		: "Previous attempt did not produce a valid <task_report>.";
	return {
		attempt: 2,
		rawOutput,
		feedback: `${prefix} Re-emit only the required XML blocks with no surrounding prose. Reuse facts already gathered; do not continue analysis or expand scope.\nRaw excerpt: ${excerpt}`,
	};
}

function buildMissingReportErrors(
	rawOutput: string,
	opts: { hitStepLimit?: boolean; schemaRepairAttempted?: boolean },
): string[] {
	const errors: string[] = [];
	const trimmed = rawOutput.trim();
	if (!trimmed) {
		errors.push("worker returned empty output - no <task_report> block was emitted");
	} else if (opts.hitStepLimit) {
		errors.push("worker hit maxSteps before emitting a <task_report> block");
	} else {
		errors.push("worker output did not contain a <task_report> block; the model likely responded outside the required schema");
	}
	if (opts.schemaRepairAttempted) {
		errors.push("schema repair retry was attempted once and still did not produce a valid <task_report>");
	}
	const excerpt = summarizeRawOutput(trimmed);
	if (excerpt) errors.push(`raw excerpt: ${excerpt}`);
	return errors;
}

function summarizeRawOutput(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= 240) return collapsed;
	return `${collapsed.slice(0, 240)}...`;
}

/** Extract the trimmed content between <tag> and </tag>; returns "" if absent. */
export function extractXmlBlock(text: string, tag: string): string {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	const s = text.indexOf(open);
	if (s === -1) return "";
	const e = text.indexOf(close, s + open.length);
	if (e === -1) return "";
	return text.slice(s + open.length, e).trim();
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
