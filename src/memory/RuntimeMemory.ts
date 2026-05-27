import type { ChatMessage } from "../types/common.js";

export interface LogEntry {
	role: string;
	content: string;
	tool_calls?: any[];
	tool_call_id?: string;
	timestamp: number;
}

export class AppendOnlyLog {
	private entries: LogEntry[] = [];

	append(entry: Partial<LogEntry>): void {
		this.entries.push({
			...entry,
			timestamp: entry.timestamp || Date.now(),
		} as LogEntry);
	}

	extend(entries: Partial<LogEntry>[]): void {
		for (const entry of entries) {
			this.append(entry);
		}
	}

	toMessages(): ChatMessage[] {
		return this.entries.map((e) => ({
			role: e.role,
			content: e.content,
			tool_calls: e.tool_calls,
			tool_call_id: e.tool_call_id,
		}));
	}

	getEntries(): LogEntry[] {
		return [...this.entries];
	}

	get length(): number {
		return this.entries.length;
	}

	clear(): void {
		this.entries = [];
	}

	compactInPlace(replacement: ChatMessage[]): void {
		this.entries = replacement.map((msg, i) => ({
			...msg,
			timestamp: Date.now(),
		}));
	}
}

export class VolatileScratch {
	reasoning: string | null = null;
	planState: Record<string, unknown> | null = null;
	notes: string[] = [];

	reset(): void {
		this.reasoning = null;
		this.planState = null;
		this.notes = [];
	}
}

export class RuntimeMemory {
	readonly log = new AppendOnlyLog();
	readonly scratch = new VolatileScratch();

	clear(): void {
		this.log.clear();
		this.scratch.reset();
	}
}
