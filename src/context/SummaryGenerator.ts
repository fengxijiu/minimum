import type { ChatMessage } from "../types/common";
import type { KeyInfo } from "../types/context";

export class SummaryGenerator {
	async generate(messages: ChatMessage[], keyInfo: KeyInfo): Promise<string> {
		const sections: string[] = [];

		sections.push(`# Task: ${keyInfo.taskObjective}`);

		if (keyInfo.decisions.length > 0) {
			sections.push("\n## Progress");
			sections.push(`- ${keyInfo.decisions.length} decisions made`);
			sections.push(`- ${keyInfo.fileChanges.length} files modified`);
			sections.push(
				`- ${keyInfo.errors.filter((e) => e.resolved).length} errors resolved`,
			);
		}

		const unresolvedErrors = keyInfo.errors.filter((e) => !e.resolved);
		if (unresolvedErrors.length > 0) {
			sections.push("\n## Current Issues");
			for (const error of unresolvedErrors) {
				sections.push(`- ${error.message}`);
			}
		}

		if (keyInfo.partialResults.length > 0) {
			sections.push("\n## Pending Items");
			for (const result of keyInfo.partialResults.slice(-5)) {
				sections.push(`- ${result}`);
			}
		}

		sections.push("\n## Statistics");
		sections.push(`- Total messages: ${messages.length}`);
		sections.push(
			`- User messages: ${messages.filter((m) => m.role === "user").length}`,
		);
		sections.push(
			`- Assistant messages: ${messages.filter((m) => m.role === "assistant").length}`,
		);
		sections.push(
			`- Tool calls: ${messages.filter((m) => m.role === "tool").length}`,
		);

		return sections.join("\n");
	}
}
