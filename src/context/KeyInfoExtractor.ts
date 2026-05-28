import type { ChatMessage } from "../types/common.js";
import type {
	Decision,
	ErrorInfo,
	FileChange,
	KeyInfo,
	TaskState,
} from "../types/context.js";

export class KeyInfoExtractor {
	async extract(
		messages: ChatMessage[],
		taskState: TaskState,
	): Promise<KeyInfo> {
		const keyInfo: KeyInfo = {
			taskObjective: taskState.objective,
			decisions: [],
			fileChanges: [],
			errors: [],
			constraints: [],
			partialResults: [],
		};

		for (const msg of messages) {
			if (msg.role === "assistant") {
				const decisions = this.extractDecisions(msg.content);
				keyInfo.decisions.push(...decisions);
			}

			if (msg.role === "tool" && this.isFileOperation(msg)) {
				const change = this.extractFileChange(msg);
				if (change) {
					keyInfo.fileChanges.push(change);
				}
			}

			if (this.isError(msg)) {
				const error = this.extractError(msg);
				keyInfo.errors.push(error);
			}

			const constraints = this.extractConstraints(msg.content);
			keyInfo.constraints.push(...constraints);
		}

		return keyInfo;
	}

	private extractDecisions(content: string): Decision[] {
		const decisions: Decision[] = [];

		const patterns = [
			/(?:I'll|I will|Let me|We should|Let's)\s+(.{20,100})/gi,
			/(?:Decision|Conclusion|Plan):\s*(.{20,100})/gi,
			/(?:Using|Choosing|Selecting)\s+(.{20,100})/gi,
		];

		for (const pattern of patterns) {
			let match;
			while ((match = pattern.exec(content)) !== null) {
				const matched = match[1];
				if (matched) {
					decisions.push({
						content: matched.trim(),
						timestamp: Date.now(),
					});
				}
			}
		}

		return decisions;
	}

	private isFileOperation(msg: ChatMessage): boolean {
		if (!msg.content) return false;
		const filePatterns = [
			/write_file|edit_file|create_file/i,
			/File written|File created|File modified/i,
			/\.(ts|js|py|json|md|txt)/,
		];
		return filePatterns.some((p) => p.test(msg.content));
	}

	private extractFileChange(msg: ChatMessage): FileChange | null {
		const content = msg.content;

		const pathMatch = content.match(/(?:file|path):\s*([^\s]+\.[a-z]+)/i);
		if (!pathMatch) return null;

		const file = pathMatch[1];
		if (!file) return null;

		let type: "create" | "modify" | "delete" = "modify";
		if (/create|new|writ/i.test(content)) {
			type = "create";
		} else if (/delete|remove/i.test(content)) {
			type = "delete";
		}

		return {
			file,
			type,
			description: content.slice(0, 100),
		};
	}

	private isError(msg: ChatMessage): boolean {
		if (!msg.content) return false;
		return /error|fail|exception|crash/i.test(msg.content);
	}

	private extractError(msg: ChatMessage): ErrorInfo {
		return {
			message: msg.content?.slice(0, 200) || "",
			type: "unknown",
			resolved: false,
			timestamp: Date.now(),
		};
	}

	private extractConstraints(content: string): string[] {
		const constraints: string[] = [];

		const patterns = [
			/(?:must|should|need to|requirement):\s*(.{10,80})/gi,
			/(?:constraint|limitation|restriction):\s*(.{10,80})/gi,
			/(?:do not|don't|never|avoid)\s+(.{10,80})/gi,
		];

		for (const pattern of patterns) {
			let match;
			while ((match = pattern.exec(content)) !== null) {
				const matched = match[1];
				if (matched) {
					constraints.push(matched.trim());
				}
			}
		}

		return constraints;
	}
}
