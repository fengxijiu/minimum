import type { ChatMessage } from "../types/common";
import type { KeyInfo } from "../types/context";
import { estimateTokens, truncateToTokens } from "../utils/token-counter";

export interface FoldOptions {
	tailFraction: number;
	maxTokens: number;
	preserveSystemMessages: boolean;
}

export class MessageFolder {
	async fold(
		messages: ChatMessage[],
		keyInfo: KeyInfo,
		options: FoldOptions,
	): Promise<ChatMessage[]> {
		if (messages.length <= 3) {
			return messages;
		}

		const systemMessages = options.preserveSystemMessages
			? messages.filter((m) => m.role === "system")
			: [];

		const historyMessages = options.preserveSystemMessages
			? messages.filter((m) => m.role !== "system")
			: messages;

		const tailCount = Math.max(
			2,
			Math.floor(historyMessages.length * options.tailFraction),
		);

		const recentMessages = historyMessages.slice(-tailCount);
		const oldMessages = historyMessages.slice(0, -tailCount);

		const summaryMessage = this.createSummaryMessage(
			keyInfo,
			oldMessages.length,
		);

		return [...systemMessages, summaryMessage, ...recentMessages];
	}

	private createSummaryMessage(
		keyInfo: KeyInfo,
		originalCount: number,
	): ChatMessage {
		let content = `[Context folded - ${originalCount} messages summarized]\n\n`;

		content += `## Objective\n${keyInfo.taskObjective}\n\n`;

		if (keyInfo.decisions.length > 0) {
			content += `## Decisions\n`;
			for (const decision of keyInfo.decisions.slice(-5)) {
				content += `- ${decision.content}\n`;
			}
			content += "\n";
		}

		if (keyInfo.fileChanges.length > 0) {
			content += `## File Changes\n`;
			for (const change of keyInfo.fileChanges.slice(-5)) {
				content += `- ${change.type}: ${change.file}\n`;
			}
			content += "\n";
		}

		const unresolvedErrors = keyInfo.errors.filter((e) => !e.resolved);
		if (unresolvedErrors.length > 0) {
			content += `## Unresolved Errors\n`;
			for (const error of unresolvedErrors.slice(-3)) {
				content += `- ${error.message}\n`;
			}
			content += "\n";
		}

		if (keyInfo.constraints.length > 0) {
			content += `## Constraints\n`;
			for (const constraint of keyInfo.constraints.slice(-5)) {
				content += `- ${constraint}\n`;
			}
		}

		return {
			role: "assistant",
			content: content.trim(),
		};
	}
}
