import type { ChatMessage } from "../types/common.js";
import type {
	SubAgentConfig,
	SubAgentMessage,
	SubAgentState,
} from "./types.js";

export class SubAgent {
	private config: SubAgentConfig;
	private state: SubAgentState;
	private messageQueue: SubAgentMessage[] = [];
	private onMessage?: (message: SubAgentMessage) => void;

	constructor(config: SubAgentConfig) {
		this.config = config;
		this.state = {
			id: config.id,
			status: "idle",
			messages: [],
			steps: 0,
			tokens: 0,
		};
	}

	async start(task: string): Promise<void> {
		this.state.status = "running";
		this.state.startTime = Date.now();
		this.state.messages = [
			{ role: "system", content: `You are a sub-agent. Task: ${task}` },
			{ role: "user", content: task },
		];

		try {
			await this.execute(task);
			this.state.status = "completed";
			this.state.result = "Task completed successfully";
		} catch (error: any) {
			this.state.status = "failed";
			this.state.error = error.message;
		} finally {
			this.state.endTime = Date.now();
		}
	}

	private async execute(task: string): Promise<void> {
		this.state.steps = 1;
		this.state.tokens = 100;
	}

	getState(): SubAgentState {
		return { ...this.state };
	}

	getConfig(): SubAgentConfig {
		return { ...this.config };
	}

	sendMessage(to: string, content: string): void {
		const message: SubAgentMessage = {
			from: this.config.id,
			to,
			content,
			timestamp: Date.now(),
		};

		this.messageQueue.push(message);
		this.onMessage?.(message);
	}

	receiveMessage(message: SubAgentMessage): void {
		this.messageQueue.push(message);
	}

	getMessages(): SubAgentMessage[] {
		return [...this.messageQueue];
	}

	setMessageHandler(handler: (message: SubAgentMessage) => void): void {
		this.onMessage = handler;
	}

	isRunning(): boolean {
		return this.state.status === "running";
	}

	isCompleted(): boolean {
		return this.state.status === "completed" || this.state.status === "failed";
	}
}
