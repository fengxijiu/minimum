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

/** Minimal interface for checkpoint persistence — implemented by both `CheckpointManager` (file-based) and `GitCheckpointManager` (git-backed). */
export interface ICheckpointManager {
	/** Optional lifecycle hook — called by `SessionManager.initialize()` if present. */
	initialize?(): Promise<void>;
	createCheckpoint(sessionId: string, messages: ChatMessage[], metadata?: Record<string, unknown>): Promise<Checkpoint>;
	restoreCheckpoint(checkpointId: string): Promise<Checkpoint | null>;
	listCheckpoints(sessionId?: string): Promise<Checkpoint[]>;
}
