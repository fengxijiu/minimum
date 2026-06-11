import type { ValidationFailure } from "./types.js";

export interface RepairFeedbackInput {
	objective: string;
	acceptance: string[];
	failure: ValidationFailure;
	failedDiff: string | null;
	touchedFiles: string[];
	remainingBudget: { perFile: number; perTask: number };
	allowedGlobs: string[];
	maxDiffChars?: number;
	maxDiagnosticChars?: number;
}

export function buildRepairFeedback(input: RepairFeedbackInput): string {
	const {
		objective,
		acceptance,
		failure,
		failedDiff,
		touchedFiles,
		remainingBudget,
		allowedGlobs,
		maxDiffChars = 20_000,
		maxDiagnosticChars = 12_000,
	} = input;

	const sections: string[] = [];

	sections.push(
		"[REPAIR REQUIRED] Validation failed — you must fix before completing.",
	);

	sections.push("## Current Task Objective", objective);

	sections.push(
		"## Acceptance Criteria",
		acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n"),
	);

	sections.push(
		"## Failure Details",
		`- Type: ${failure.checkerType}`,
		`- Severity: ${failure.severity}`,
		`- Affected Files: ${failure.affectedFiles.join(", ") || "unknown"}`,
		failure.command ? `- Command: ${failure.command}` : "",
		failure.exitCode !== undefined ? `- Exit Code: ${failure.exitCode}` : "",
	);

	if (failure.diagnostics.length > 0) {
		const diagText = failure.diagnostics
			.map((d) => {
				const loc =
					d.line !== undefined
						? `${d.file}(${d.line},${d.column ?? 0}): `
						: `${d.file}: `;
				const code = d.errorCode ? `[${d.errorCode}] ` : "";
				return `  ${loc}${code}${d.message}`;
			})
			.join("\n");
		sections.push(
			"## Diagnostics",
			truncate(diagText, maxDiagnosticChars),
		);
	}

	if (failedDiff) {
		sections.push(
			"## Failed Diff (your last change)",
			"```diff",
			truncate(failedDiff, maxDiffChars),
			"```",
		);
	}

	if (touchedFiles.length > 0) {
		sections.push(
			"## Touched Files",
			touchedFiles.map((f) => `- ${f}`).join("\n"),
		);
	}

	sections.push(
		"## Repair Budget Remaining",
		`- Per-file attempts left: ${remainingBudget.perFile}`,
		`- Per-task attempts left: ${remainingBudget.perTask}`,
	);

	sections.push(
		"## Allowed Write Globs",
		allowedGlobs.map((g) => `- ${g}`).join("\n"),
	);

	sections.push(
		"## Required: Choose ONE of these actions",
		"1. FIX: Edit the affected files to resolve the failure above",
		"2. BLOCKED: Report blocked if you cannot fix (explain what you need)",
		"3. FAILED: Report failed with evidence if the issue is unrecoverable",
	);

	sections.push(
		"## Forbidden",
		"- Do NOT report completed while validation failures are unresolved",
		"- Do NOT expand scope beyond allowedGlobs",
		"- Do NOT bypass tests or ignore errors",
	);

	return sections.filter((s) => s !== "").join("\n\n");
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars) + `\n... [truncated, ${text.length - maxChars} chars omitted]`;
}
