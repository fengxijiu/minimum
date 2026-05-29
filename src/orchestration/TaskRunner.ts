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
	/** Set when staging write succeeds but fails to persist — task status is still valid. */
	stagingError?: string;
	durationMs: number;
}

/** Injectable worker executor — real impl calls the LLM; tests use stubs. */
export interface WorkerExecutor {
	run(contract: TaskContract, filteredTools: string[]): Promise<string>;
}

export interface TaskRunnerOptions {
	projectRoot: string;
	executor: WorkerExecutor;
}

/**
 * Run a single contracted task end-to-end.
 *
 * Pipeline:
 *   1. Validate contract — abort with contract_invalid if invalid.
 *   2. Filter tools to the persona's effective allowlist.
 *   3. Execute via the injected WorkerExecutor.
 *   4. Parse <task_report> and optional <memory_candidate> from output.
 *   5. If a candidate was emitted, persist it to _staging/.
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

	let rawOutput: string;
	try {
		rawOutput = await opts.executor.run(contract, filteredTools);
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

	const report = extractXmlBlock(rawOutput, "task_report");
	const memBlock = extractXmlBlock(rawOutput, "memory_candidate") || undefined;
	const status = detectStatus(report);

	let stagingError: string | undefined;
	if (memBlock) {
		const candidate = parseMemoryCandidate(memBlock, contract);
		try {
			await writeCandidate(opts.projectRoot, candidate);
		} catch (err) {
			stagingError = err instanceof Error ? err.message : String(err);
		}
	}

	return {
		...base,
		status,
		report,
		memoryCandidateBody: memBlock,
		errors: [],
		...(stagingError !== undefined && { stagingError }),
		durationMs: Date.now() - start,
	};
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
		// Unrecognized key — skip it rather than breaking so that future
		// frontmatter fields added after this one are still parsed.
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
