import type { TransactionSummary } from "./types.js";

export function generateHumanReport(summary: TransactionSummary): string {
	const sections: string[] = [];

	sections.push(`# Transaction Report: ${summary.taskId}`);

	sections.push("## Task Overview");
	sections.push(
		`- **Transaction ID:** ${summary.transactionId}`,
		`- **Task ID:** ${summary.taskId}`,
		`- **Persona:** ${summary.personaId}`,
		`- **Status:** ${summary.status}`,
		`- **Duration:** ${summary.durationMs}ms`,
		`- **Repair Attempts:** ${summary.repairAttempts}`,
	);

	if (summary.touchedFiles.length > 0) {
		sections.push(
			"## Changed Files",
			summary.touchedFiles.map((f) => `- ${f}`).join("\n"),
		);
	}

	if (summary.validatorsRun.length > 0) {
		sections.push(
			"## Validators Run",
			summary.validatorsRun.map((v) => `- ${v}`).join("\n"),
		);
	}

	if (summary.failures.length > 0) {
		sections.push("## Validation Timeline");
		for (const f of summary.failures) {
			const resolved = f.resolved ? "resolved" : "unresolved";
			sections.push(
				`### ${f.failureId} — ${f.checkerType} [${resolved}]`,
				`- **Severity:** ${f.severity}`,
				`- **Policy:** ${f.policy}`,
				`- **Affected Files:** ${f.affectedFiles.join(", ")}`,
				`- **Attempt:** ${f.attemptIndex}`,
				`- **Time:** ${new Date(f.timestamp).toISOString()}`,
			);
			if (f.diagnostics.length > 0) {
				sections.push(
					"**Diagnostics:**",
					f.diagnostics
						.map((d) => {
							const loc = d.line !== undefined ? `${d.file}:${d.line}` : d.file;
							return `  - ${loc}: ${d.message}`;
						})
						.join("\n"),
				);
			}
		}
	}

	if (summary.unresolvedFailures.length > 0) {
		sections.push(
			"## Unresolved Failures",
			summary.unresolvedFailures
				.map((f) => `- ${f.failureId}: ${f.checkerType} — ${f.diagnostics[0]?.message ?? "unknown"}`)
				.join("\n"),
		);
	}

	if (summary.applyCommit) {
		sections.push(`## Apply Commit\n\`${summary.applyCommit}\``);
	}

	if (summary.rollbackReason) {
		sections.push(`## Rollback Reason\n${summary.rollbackReason}`);
	}

	if (summary.finalEvidence) {
		sections.push(`## Final Evidence\n${summary.finalEvidence}`);
	}

	sections.push("## Result");
	sections.push(`**${summary.status}** — ${summary.repairAttempts} repair attempt(s), ${summary.unresolvedFailures.length} unresolved failure(s)`);

	return sections.join("\n\n");
}
