import type { ChatMessage } from "../types/common.js";

export interface SubAgentConfig {
	id: string;
	name: string;
	task: string;
	maxSteps: number;
	maxTokens: number;
	tools?: string[];
}

export interface SubAgentState {
	id: string;
	status: "idle" | "running" | "completed" | "failed";
	messages: ChatMessage[];
	result?: string;
	error?: string;
	steps: number;
	tokens: number;
	startTime?: number;
	endTime?: number;
}

export interface SubAgentMessage {
	from: string;
	to: string;
	content: string;
	timestamp: number;
}
