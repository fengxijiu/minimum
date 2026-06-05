import { McpClient } from "./McpClient.js";
import { McpAuditLogger } from "./McpAuditLogger.js";
import type {
	McpListedPrompt,
	McpListedResource,
	McpServerConfig,
	McpServerDetails,
	McpTool,
	McpToolCall,
	McpToolResult,
} from "./types.js";

export interface McpManagerOptions {
	projectRoot?: string;
	audit?: boolean;
}

export class McpManager {
	private clients: Map<string, McpClient> = new Map();
	private configs: Map<string, McpServerConfig> = new Map();
	private auditLogger?: McpAuditLogger;

	constructor(options: McpManagerOptions = {}) {
		if (options.audit === true) {
			this.auditLogger = new McpAuditLogger(options.projectRoot ?? process.cwd());
		}
	}

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

	getServerDetails(): McpServerDetails[] {
		return this.listServers().map((name) => {
			const client = this.clients.get(name);
			const config = this.configs.get(name);
			if (!client || !config) {
				throw new Error(`MCP server not found: ${name}`);
			}
			return {
				name,
				transport: config.transport,
				...(config.url ? { url: config.url } : {}),
				headerKeys: Object.keys(config.headers ?? {}),
				...(config.tools?.length ? { allowedTools: [...config.tools] } : {}),
				...(config.denyTools?.length ? { deniedTools: [...config.denyTools] } : {}),
				toolNames: client.getTools().map((tool) => tool.name),
				toolCount: client.getTools().length,
				resourceCount: client.getResources().length,
				promptCount: client.getPrompts().length,
			};
		});
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

	getAllResources(): McpListedResource[] {
		const resources: McpListedResource[] = [];
		for (const [name, client] of this.clients) {
			for (const resource of client.getResources()) {
				resources.push({ ...resource, server: name });
			}
		}
		return resources;
	}

	getAllPrompts(): McpListedPrompt[] {
		const prompts: McpListedPrompt[] = [];
		for (const [name, client] of this.clients) {
			for (const prompt of client.getPrompts()) {
				prompts.push({ ...prompt, server: name });
			}
		}
		return prompts;
	}

	async callTool(
		serverName: string,
		toolCall: McpToolCall,
	): Promise<McpToolResult> {
		const client = this.clients.get(serverName);
		if (!client) {
			const result: McpToolResult = {
				content: [{ type: "text", text: `Server not found: ${serverName}` }],
				isError: true,
			};
			await this.audit("tool", serverName, toolCall.name, toolCall.arguments, false, 0, result.content[0]?.text);
			return result;
		}

		const started = Date.now();
		try {
			const result = await client.callTool(toolCall);
			await this.audit("tool", serverName, toolCall.name, toolCall.arguments, !result.isError, Date.now() - started, result.isError ? result.content[0]?.text : undefined);
			return result;
		} catch (error) {
			await this.audit("tool", serverName, toolCall.name, toolCall.arguments, false, Date.now() - started, String((error as Error)?.message ?? error));
			throw error;
		}
	}

	async readResource(ref: string): Promise<any> {
		const resolved = this.resolveResourceRef(ref);
		const started = Date.now();
		try {
			const result = await resolved.client.readResource(resolved.uri);
			await this.audit("resource", resolved.server, resolved.uri, { ref }, true, Date.now() - started);
			return result;
		} catch (error) {
			await this.audit("resource", resolved.server, resolved.uri, { ref }, false, Date.now() - started, String((error as Error)?.message ?? error));
			throw error;
		}
	}

	async getPrompt(ref: string, args?: Record<string, any>): Promise<any> {
		const resolved = this.resolvePromptRef(ref);
		const started = Date.now();
		try {
			const result = await resolved.client.getPrompt(resolved.name, args);
			await this.audit("prompt", resolved.server, resolved.name, args, true, Date.now() - started);
			return result;
		} catch (error) {
			await this.audit("prompt", resolved.server, resolved.name, args, false, Date.now() - started, String((error as Error)?.message ?? error));
			throw error;
		}
	}

	async disconnectAll(): Promise<void> {
		for (const client of this.clients.values()) {
			await client.disconnect();
		}
		this.clients.clear();
		this.configs.clear();
	}

	private resolveResourceRef(ref: string): { client: McpClient; server: string; uri: string } {
		const explicit = splitQualifiedRef(ref);
		if (explicit) {
			const client = this.clients.get(explicit.server);
			if (!client) throw new Error(`MCP server not found: ${explicit.server}`);
			return { client, server: explicit.server, uri: explicit.value };
		}
		let match: { client: McpClient; server: string; uri: string } | null = null;
		for (const [name, client] of this.clients) {
			if (!client.getResources().some((resource) => resource.uri === ref)) continue;
			if (match) {
				throw new Error(`resource URI is ambiguous: ${ref}. Use <server>::<uri>.`);
			}
			match = { client, server: name, uri: ref };
			if (!this.configs.has(name)) break;
		}
		if (!match) throw new Error(`resource not found: ${ref}`);
		return match;
	}

	private resolvePromptRef(ref: string): { client: McpClient; server: string; name: string } {
		const explicit = splitQualifiedRef(ref);
		if (explicit) {
			const client = this.clients.get(explicit.server);
			if (!client) throw new Error(`MCP server not found: ${explicit.server}`);
			return { client, server: explicit.server, name: explicit.value };
		}
		let match: { client: McpClient; server: string; name: string } | null = null;
		for (const [server, client] of this.clients) {
			if (!client.getPrompts().some((prompt) => prompt.name === ref)) continue;
			if (match) {
				throw new Error(`prompt name is ambiguous: ${ref}. Use <server>::<name>.`);
			}
			match = { client, server, name: ref };
		}
		if (!match) throw new Error(`prompt not found: ${ref}`);
		return match;
	}

	private async audit(
		kind: "tool" | "resource" | "prompt",
		server: string,
		name: string,
		args: unknown,
		success: boolean,
		durationMs: number,
		error?: string,
	): Promise<void> {
		try {
			await this.auditLogger?.log({ kind, server, name, args, success, durationMs, ...(error ? { error } : {}) });
		} catch {
			// Auditing should never make MCP calls fail.
		}
	}
}

function splitQualifiedRef(ref: string): { server: string; value: string } | null {
	const index = ref.indexOf("::");
	if (index <= 0) return null;
	return {
		server: ref.slice(0, index),
		value: ref.slice(index + 2),
	};
}
