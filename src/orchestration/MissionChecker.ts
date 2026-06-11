import type { PersonaId } from "../personas/Persona.js";
import { getPersona, normalizePersonaIdOrAlias } from "../personas/PersonaRegistry.js";
import type { ArtifactPaths } from "./PipelineArtifactStore.js";
import type { RefinementEntry } from "./Refiner.js";
import type { CoarseDag, CoarseTask } from "./TaskContract.js";
import type { TaskResult } from "./TaskRunner.js";
import type { TransactionSummary } from "../transaction/types.js";

export type MissionDecision =
	| "APPROVED_TO_W4"
	| "LOOP_BACK_TO_W1"
	| "NEEDS_HUMAN_CONFIRMATION";

export interface MissionCheckInput {
	userRequest: string;
	dag: CoarseDag;
	refinements: RefinementEntry[];
	results: TaskResult[];
	canonicalMemory: string;
	knownIssues: string[];
	loopIndex: number;
	maxRepairLoops: number;
	artifactPaths: ArtifactPaths;
	/** Transaction summaries from task execution — validation evidence, repair counts, file touches. */
	transactionSummaries?: TransactionSummary[];
}

export interface MissionLoopBackTask {
	title: string;
	priority: string;
	blocking: boolean;
	reason: string;
	sourceIssue: string;
	expectedOutcome: string;
	personaId: PersonaId;
	acceptance: string[];
	allowedGlobs: string[];
}

export interface MissionCheckReport {
	decision: MissionDecision;
	reason: string;
	tasks: MissionLoopBackTask[];
	raw: string;
}

export type MissionCheckCompileResult =
	| { ok: true; report: MissionCheckReport }
	| { ok: false; error: string; raw?: string };

const DECISIONS: MissionDecision[] = [
	"APPROVED_TO_W4",
	"LOOP_BACK_TO_W1",
	"NEEDS_HUMAN_CONFIRMATION",
];

export function compileMissionCheck(text: string): MissionCheckCompileResult {
	const decision = parseDecision(text);
	if (!decision) {
		return {
			ok: false,
			error: "mission check report must include Decision: APPROVED_TO_W4 | LOOP_BACK_TO_W1 | NEEDS_HUMAN_CONFIRMATION",
			raw: text,
		};
	}

	const tasks = decision === "LOOP_BACK_TO_W1" ? parseLoopBackTasks(text) : [];
	const contractIssues = decision === "LOOP_BACK_TO_W1" ? validateLoopBackContractReadiness(tasks) : [];
	if (contractIssues.length > 0) {
		return {
			ok: false,
			error: `mission loop-back tasks cannot produce usable contracts: ${contractIssues.join("; ")}`,
			raw: text,
		};
	}

	return {
		ok: true,
		report: {
			decision,
			reason: parseReason(text),
			tasks,
			raw: text,
		},
	};
}

export function loopBackTasksToCoarseTasks(
	tasks: MissionLoopBackTask[],
	loopIndex: number,
): CoarseTask[] {
	return tasks.map((task, i) => ({
		id: `T3.5-${loopIndex + 1}-${i + 1}`,
		personaId: task.personaId,
		objective: [
			task.title,
			task.expectedOutcome ? `Expected outcome: ${task.expectedOutcome}` : "",
			task.reason ? `Reason: ${task.reason}` : "",
		]
			.filter(Boolean)
			.join("\n"),
		parallelGroup: `mission-repair-${loopIndex + 1}`,
		dependsOn: [],
		needsRefine: true,
		...(task.allowedGlobs.length > 0 && { allowedGlobs: task.allowedGlobs }),
		acceptance: task.acceptance,
		priority: task.priority,
		sourceIssue: task.sourceIssue,
		blocking: task.blocking,
	}));
}

function parseDecision(text: string): MissionDecision | undefined {
	const m = text.match(/\bDecision\s*:\s*([^\n]+)/i);
	if (!m) return undefined;
	const token = stripWrappingEmphasis(m[1]!).split(/\s+/)[0]?.toUpperCase();
	if (!token) return undefined;
	return DECISIONS.includes(token as MissionDecision) ? (token as MissionDecision) : undefined;
}

function parseReason(text: string): string {
	const m = text.match(/\bReason:\s*([\s\S]*?)(?:\n##\s+\d+\.|\n##\s+|$)/i);
	if (!m) return "";
	return cleanupMultiline(m[1]!);
}

function parseLoopBackTasks(text: string): MissionLoopBackTask[] {
	const section = text.match(/##\s*7\.\s*Loop-Back Tasks for W1\s*([\s\S]*?)(?:\n##\s*8\.|\n##\s*9\.|$)/i);
	if (!section) return [];

	const body = section[1]!;
	const taskHeaderRe = /^###\s*Task\s+\d+\s*:\s*(.+)$/gim;
	const headers = [...body.matchAll(taskHeaderRe)];
	const tasks: MissionLoopBackTask[] = [];
	for (let i = 0; i < headers.length; i++) {
		const header = headers[i]!;
		const next = headers[i + 1];
		const start = (header.index ?? 0) + header[0].length;
		const end = next?.index ?? body.length;
		const block = body.slice(start, end);
		tasks.push(parseLoopBackTask(header[1]!.trim(), block));
	}
	return tasks;
}

function parseLoopBackTask(title: string, block: string): MissionLoopBackTask {
	const priority = getField(block, "Priority") || "P1";
	const blockingText = getField(block, "Blocking") || "Yes";
	const reason = getField(block, "Reason") || "";
	const sourceIssue = getField(block, "Source issue") || getField(block, "Source Issue") || "";
	const expectedOutcome = getField(block, "Expected outcome") || getField(block, "Expected Outcome") || "";
	const owner = getField(block, "Suggested owner agent") || getField(block, "Suggested Owner Agent") || "";
	const acceptanceText = getField(block, "Acceptance criteria") || getField(block, "Acceptance Criteria") || "";
	const allowedGlobsText =
		getField(block, "Allowed globs") ||
		getField(block, "Allowed Globs") ||
		getField(block, "allowedGlobs") ||
		getField(block, "Suggested allowed globs") ||
		getField(block, "Suggested Allowed Globs") ||
		"";

	return {
		title,
		priority,
		blocking: /^y|true|block/i.test(blockingText.trim()),
		reason,
		sourceIssue,
		expectedOutcome,
		personaId: normalizePersona(owner),
		acceptance: splitAcceptance(acceptanceText, expectedOutcome || title),
		allowedGlobs: splitList(allowedGlobsText),
	};
}

function validateLoopBackContractReadiness(tasks: MissionLoopBackTask[]): string[] {
	const issues: string[] = [];
	const globOwners = new Map<string, string>();

	for (const task of tasks) {
		const prefix = task.title || task.personaId;
		if (!task.title || task.title.trim().length < 4) {
			issues.push(`${prefix}: title must be concrete`);
		}
		if (!/^P[0-3]$/.test(task.priority.trim())) {
			issues.push(`${prefix}: priority must be P0, P1, P2, or P3`);
		}
		if (!task.reason.trim()) {
			issues.push(`${prefix}: reason is required`);
		}
		if (!task.sourceIssue.trim()) {
			issues.push(`${prefix}: sourceIssue is required`);
		}
		if (!task.expectedOutcome.trim()) {
			issues.push(`${prefix}: expectedOutcome is required`);
		}
		if (task.acceptance.length === 0 || task.acceptance.some((item) => !isConcreteListItem(item))) {
			issues.push(`${prefix}: acceptance criteria must be non-empty and concrete`);
		}

		const persona = getPersona(task.personaId);
		const needsContractGlobs = persona.pathPolicy.canWrite && persona.pathPolicy.alwaysAllowedGlobs.length === 0;
		if (needsContractGlobs && task.allowedGlobs.length === 0) {
			issues.push(`${prefix}: ${task.personaId} requires Allowed globs`);
		}
		for (const glob of task.allowedGlobs) {
			if (!isConcreteGlob(glob)) {
				issues.push(`${prefix}: allowed glob ${JSON.stringify(glob)} is not concrete`);
				continue;
			}
			if (persona.pathPolicy.forbiddenGlobs.includes(glob)) {
				issues.push(`${prefix}: allowed glob ${glob} is forbidden for ${task.personaId}`);
			}
			const existing = globOwners.get(glob);
			if (existing) {
				issues.push(`${prefix}: allowed glob ${glob} conflicts with ${existing}`);
			} else {
				globOwners.set(glob, prefix);
			}
		}
	}

	return issues;
}

function isConcreteListItem(item: string): boolean {
	const trimmed = item.trim();
	return trimmed.length > 0 && !/\b(TBD|TODO|unknown|unclear)\b/i.test(trimmed);
}

function isConcreteGlob(glob: string): boolean {
	const trimmed = glob.trim();
	if (!isConcreteListItem(trimmed)) return false;
	return !["*", "**", "**/*", ".", "./"].includes(trimmed);
}

function getField(block: string, label: string): string | undefined {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const fieldRe = new RegExp(`^\\s*-\\s*${escaped}:\\s*(.*)$`, "i");
	const lines = block.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]!.match(fieldRe);
		if (!m) continue;
		const collected = [m[1] ?? ""];
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j]!;
			if (/^###\s+Task/i.test(line) || /^##\s+/.test(line)) break;
			if (/^-\s*[A-Za-z][A-Za-z\s]+:\s*/.test(line)) break;
			collected.push(line);
		}
		return cleanupMultiline(collected.join("\n"));
	}
	return undefined;
}

function splitAcceptance(text: string, fallback: string): string[] {
	const lines = splitList(text);
	if (lines.length > 0) return lines;
	const trimmed = text.trim();
	return [trimmed || `complete: ${fallback}`];
}

function splitList(text: string): string[] {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
		.filter(Boolean);
	return lines;
}

function cleanupMultiline(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => stripWrappingEmphasis(line.replace(/^\s*[-*]\s*/, "")))
		.filter(Boolean)
		.join("\n");
}

function stripWrappingEmphasis(text: string): string {
	let value = text.trim();
	let prev = "";
	while (prev !== value) {
		prev = value;
		value = value.replace(/^[*_`'"]+/, "").replace(/[*_`'"]+$/, "").trim();
	}
	return value;
}

function normalizePersona(raw: string): PersonaId {
	return normalizePersonaIdOrAlias(raw) ?? "code_executor";
}
