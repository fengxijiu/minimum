import type { ToolDefinition } from "../types/common.js";
import type { Tool } from "../tools/ToolRegistry.js";
import type { McpManager } from "./McpManager.js";
import type { McpTool, McpToolResult } from "./types.js";

/** Tool-name prefix so MCP tools never collide with built-in tool names. */
export function mcpToolName(server: string, tool: string): string {
	const safe = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
	return `mcp__${safe(server)}__${safe(tool)}`;
}

/** Flatten an MCP tool result's content blocks into a single string. */
function flattenResult(result: McpToolResult): string {
	const parts: string[] = [];
	for (const block of result.content ?? []) {
		if (block.type === "text" && block.text) parts.push(block.text);
		else if (block.type === "resource" && block.text) parts.push(block.text);
		else if (block.type === "image") parts.push(`[image ${block.mimeType ?? "data"}]`);
	}
	return parts.join("\n").trim() || "(empty MCP result)";
}

/**
 * McpToolAdapter — wraps one tool exposed by an MCP server as a Minimum `Tool`,
 * so the agent loop can call it like any built-in tool. Tool calls are forwarded
 * through the owning McpManager to the right server.
 */
export class McpToolAdapter implements Tool {
	readonly name: string;
	readonly description: string;

	constructor(
		private readonly manager: McpManager,
		private readonly serverName: string,
		private readonly tool: McpTool,
	) {
		this.name = mcpToolName(serverName, tool.name);
		this.description = tool.description || `MCP tool ${tool.name} from ${serverName}`;
	}

	getDefinition(): ToolDefinition {
		return {
			name: this.name,
			description: this.description,
			parameters: this.tool.inputSchema ?? { type: "object", properties: {} },
		};
	}

	async execute(args: Record<string, any>): Promise<string> {
		const result = await this.manager.callTool(this.serverName, {
			name: this.tool.name,
			arguments: args ?? {},
		});
		const text = flattenResult(result);
		if (result.isError) {
			throw new Error(`MCP tool ${this.name} failed: ${text}`);
		}
		return text;
	}
}
