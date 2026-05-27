import type { ErrorRecord, ToolCall } from "../types/iteration";

export class ErrorRecorder {
	private history: Map<string, ErrorRecord[]> = new Map();

	record(
		taskId: string,
		error: Error,
		attempt: number,
		toolCall?: ToolCall,
	): void {
		const records = this.history.get(taskId) || [];

		records.push({
			attempt,
			message: error.message,
			type: this.classifyError(error),
			stack: error.stack,
			timestamp: Date.now(),
			toolCall,
		});

		this.history.set(taskId, records);
	}

	getHistory(taskId: string): ErrorRecord[] {
		return this.history.get(taskId) || [];
	}

	clearHistory(taskId?: string): void {
		if (taskId) {
			this.history.delete(taskId);
		} else {
			this.history.clear();
		}
	}

	private classifyError(
		error: Error,
	): "validation" | "execution" | "timeout" | "unknown" {
		const message = error.message.toLowerCase();

		if (message.includes("validation") || message.includes("invalid")) {
			return "validation";
		}
		if (message.includes("timeout") || message.includes("timed out")) {
			return "timeout";
		}
		if (message.includes("execution") || message.includes("failed")) {
			return "execution";
		}

		return "unknown";
	}
}
