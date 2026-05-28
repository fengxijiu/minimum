import type { ToolDefinition } from "../types/common.js";

export interface Tool {
	name: string;
	description: string;
	getDefinition(): ToolDefinition;
	execute(args: Record<string, any>, context?: any): Promise<string>;
}

export interface ToolCallContext {
	signal?: AbortSignal;
	workingDirectory?: string;
}

export class ToolRegistry {
	private tools: Map<string, Tool> = new Map();

	register(tool: Tool): void {
		this.tools.set(tool.name, tool);
	}

	unregister(name: string): boolean {
		return this.tools.delete(name);
	}

	get(name: string): Tool | undefined {
		return this.tools.get(name);
	}

	getAll(): Tool[] {
		return Array.from(this.tools.values());
	}

	getDefinitions(): ToolDefinition[] {
		return Array.from(this.tools.values()).map((tool) => tool.getDefinition());
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	async execute(
		toolCall: { function: { name: string; arguments: string } },
		context?: ToolCallContext,
	): Promise<{ content: string; isError?: boolean }> {
		const tool = this.tools.get(toolCall.function.name);

		if (!tool) {
			return {
				content: `Unknown tool: ${toolCall.function.name}`,
				isError: true,
			};
		}

		try {
			const args = JSON.parse(toolCall.function.arguments);
			const result = await tool.execute(args, context);
			return { content: result };
		} catch (error: any) {
			return {
				content: `Tool execution failed: ${error.message}`,
				isError: true,
			};
		}
	}
}
