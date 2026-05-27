import { McpClient } from "./McpClient.js";
import type {
	McpServerConfig,
	McpTool,
	McpToolCall,
	McpToolResult,
} from "./types.js";

export class McpManager {
	private clients: Map<string, McpClient> = new Map();
	private configs: Map<string, McpServerConfig> = new Map();

	async addServer(config: McpServerConfig): Promise<void> {
		const client = new McpClient(config);
		await client.connect();

		this.clients.set(config.name, client);
		this.configs.set(config.name, config);
	}

	async removeServer(name: string): Promise<boolean> {
		const client = this.clients.get(name);
		if (client) {
			await client.disconnect();
			this.clients.delete(name);
			this.configs.delete(name);
			return true;
		}
		return false;
	}

	getClient(name: string): McpClient | undefined {
		return this.clients.get(name);
	}

	listServers(): string[] {
		return Array.from(this.clients.keys());
	}

	getAllTools(): Array<McpTool & { server: string }> {
		const tools: Array<McpTool & { server: string }> = [];

		for (const [name, client] of this.clients) {
			for (const tool of client.getTools()) {
				tools.push({ ...tool, server: name });
			}
		}

		return tools;
	}

	async callTool(
		serverName: string,
		toolCall: McpToolCall,
	): Promise<McpToolResult> {
		const client = this.clients.get(serverName);
		if (!client) {
			return {
				content: [{ type: "text", text: `Server not found: ${serverName}` }],
				isError: true,
			};
		}

		return client.callTool(toolCall);
	}

	async disconnectAll(): Promise<void> {
		for (const client of this.clients.values()) {
			await client.disconnect();
		}
		this.clients.clear();
		this.configs.clear();
	}
}
