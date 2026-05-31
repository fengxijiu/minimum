import type { PersonaId } from "../personas/Persona.js";
import { listPersonaIds } from "../personas/PersonaRegistry.js";
import type { RefinementEntry } from "./Refiner.js";
import type { CoarseDag, CoarseTask } from "./TaskContract.js";
import type { TaskResult } from "./TaskRunner.js";

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

const VALID_PERSONA_IDS = new Set<PersonaId>(listPersonaIds());

export function compileMissionCheck(text: string): MissionCheckCompileResult {
	const decision = parseDecision(text);
	if (!decision) {
		return {
			ok: false,
			error: "mission check report must include Decision: APPROVED_TO_W4 | LOOP_BACK_TO_W1 | NEEDS_HUMAN_CONFIRMATION",
			raw: text,
		};
	}

	return {
		ok: true,
		report: {
			decision,
			reason: parseReason(text),
			tasks: decision === "LOOP_BACK_TO_W1" ? parseLoopBackTasks(text) : [],
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
	}));
}

function parseDecision(text: string): MissionDecision | undefined {
	const m = text.match(/\bDecision:\s*(APPROVED_TO_W4|LOOP_BACK_TO_W1|NEEDS_HUMAN_CONFIRMATION)\b/i);
	if (!m) return undefined;
	const value = m[1]!.toUpperCase() as MissionDecision;
	return DECISIONS.includes(value) ? value : undefined;
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

	return {
		title,
		priority,
		blocking: /^y|true|block/i.test(blockingText.trim()),
		reason,
		sourceIssue,
		expectedOutcome,
		personaId: normalizePersona(owner),
		acceptance: splitAcceptance(acceptanceText, expectedOutcome || title),
	};
}

function getField(block: string, label: string): string | undefined {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(
		`^-\\s*${escaped}:\\s*([\\s\\S]*?)(?=\\n-\\s*[A-Za-z][A-Za-z\\s]+:\\s*|\\n###\\s+Task|\\n##\\s+|$)`,
		"im",
	);
	const m = block.match(re);
	if (!m) return undefined;
	return cleanupMultiline(m[1]!);
}

function splitAcceptance(text: string, fallback: string): string[] {
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
		.filter(Boolean);
	if (lines.length > 0) return lines;
	const trimmed = text.trim();
	return [trimmed || `complete: ${fallback}`];
}

function cleanupMultiline(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
		.filter(Boolean)
		.join("\n");
}

function normalizePersona(raw: string): PersonaId {
	const normalized = raw
		.trim()
		.toLowerCase()
		.replace(/[`*]/g, "")
		.replace(/[\s-]+/g, "_");
	const aliases: Record<string, PersonaId> = {
		coder: "code_executor",
		code: "code_executor",
		developer: "code_executor",
		implementation: "code_executor",
		tester: "test_writer",
		tests: "test_writer",
		test: "test_writer",
		runner: "test_runner",
		review: "reviewer",
		reviewer: "reviewer",
		documentation: "docs",
		doc: "docs",
		repo: "repo_scout",
		scout: "repo_scout",
		context: "context_builder",
	};
	const aliased = aliases[normalized] ?? normalized;
	if (VALID_PERSONA_IDS.has(aliased as PersonaId) && aliased !== "master_planner") {
		return aliased as PersonaId;
	}
	return "code_executor";
}
