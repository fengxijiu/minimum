export type MemoryLayer = "session" | "project" | "global";

export type MemoryConfidence = "high" | "medium" | "low" | number;

export interface MemoryRecord {
	id: string;
	layer: MemoryLayer;
	scope: string;
	key: string;
	content: string;
	confidence: MemoryConfidence;
	source: string;
	updatedAt: string | number | Date;
	tags: string[];
	relatedFiles: string[];
}

export interface CurrentTask {
	input?: string;
	prompt?: string;
	content?: string;
	explicitPreferences?: string[];
}
