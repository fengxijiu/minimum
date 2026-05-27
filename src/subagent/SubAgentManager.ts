import { SubAgent } from "./SubAgent.js";
import type {
	SubAgentConfig,
	SubAgentMessage,
	SubAgentState,
} from "./types.js";

export class SubAgentManager {
	private agents: Map<string, SubAgent> = new Map();
	private maxConcurrent: number;
	private messageHandlers: Map<string, (message: SubAgentMessage) => void> =
		new Map();

	constructor(maxConcurrent = 3) {
		this.maxConcurrent = maxConcurrent;
	}

	createAgent(config: SubAgentConfig): SubAgent {
		const agent = new SubAgent(config);

		agent.setMessageHandler((message) => {
			this.handleMessage(message);
		});

		this.agents.set(config.id, agent);
		return agent;
	}

	getAgent(id: string): SubAgent | undefined {
		return this.agents.get(id);
	}

	listAgents(): SubAgentState[] {
		return Array.from(this.agents.values()).map((agent) => agent.getState());
	}

	getRunningAgents(): SubAgentState[] {
		return this.listAgents().filter((state) => state.status === "running");
	}

	async startAgent(id: string, task: string): Promise<void> {
		const agent = this.agents.get(id);
		if (!agent) {
			throw new Error(`Agent not found: ${id}`);
		}

		const running = this.getRunningAgents().length;
		if (running >= this.maxConcurrent) {
			throw new Error(
				`Maximum concurrent agents reached: ${this.maxConcurrent}`,
			);
		}

		await agent.start(task);
	}

	async stopAgent(id: string): Promise<void> {
		const agent = this.agents.get(id);
		if (agent) {
			this.agents.delete(id);
		}
	}

	sendMessage(from: string, to: string, content: string): void {
		const fromAgent = this.agents.get(from);
		const toAgent = this.agents.get(to);

		if (fromAgent && toAgent) {
			fromAgent.sendMessage(to, content);
			toAgent.receiveMessage({
				from,
				to,
				content,
				timestamp: Date.now(),
			});
		}
	}

	private handleMessage(message: SubAgentMessage): void {
		const handler = this.messageHandlers.get(message.to);
		handler?.(message);
	}

	setMessageHandler(
		agentId: string,
		handler: (message: SubAgentMessage) => void,
	): void {
		this.messageHandlers.set(agentId, handler);
	}

	removeAgent(id: string): boolean {
		return this.agents.delete(id);
	}

	clear(): void {
		this.agents.clear();
		this.messageHandlers.clear();
	}
}
