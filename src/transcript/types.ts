import type { ChatMessage } from "../types/common.js";

export interface TranscriptEntry {
	id: string;
	timestamp: number;
	type: "message" | "tool_call" | "tool_result" | "error" | "system";
	content: any;
	metadata?: Record<string, any>;
}

export interface Transcript {
	id: string;
	sessionId: string;
	entries: TranscriptEntry[];
	startTime: number;
	endTime?: number;
	metadata: Record<string, any>;
}

export interface ReplayOptions {
	speed?: number;
	startFrom?: number;
	stopAt?: number;
	filter?: (entry: TranscriptEntry) => boolean;
}
