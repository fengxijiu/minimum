import type { ChatMessage } from "../types/common.js";

export interface Checkpoint {
	id: string;
	sessionId: string;
	messages: ChatMessage[];
	metadata: Record<string, any>;
	createdAt: number;
}

export interface SessionState {
	id: string;
	messages: ChatMessage[];
	checkpoints: Checkpoint[];
	metadata: Record<string, any>;
	createdAt: number;
	updatedAt: number;
}
