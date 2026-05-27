export interface ToolDefinition {
	name: string;
	description?: string;
	parameters?: Record<string, any>;
	fn: (args: any, ctx?: any) => any;
}

export class MockToolRegistry {
	private tools: Map<string, ToolDefinition> = new Map();

	register(tool: ToolDefinition): void {
		this.tools.set(tool.name, tool);
	}

	get(name: string): ToolDefinition | undefined {
		return this.tools.get(name);
	}

	getAll(): ToolDefinition[] {
		return Array.from(this.tools.values());
	}

	getDefinitions(): Array<{
		name: string;
		description?: string;
		parameters?: Record<string, any>;
	}> {
		return Array.from(this.tools.values()).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
	}

	async execute(
		toolCall: { function: { name: string; arguments: string } },
		context?: any,
	): Promise<any> {
		const tool = this.tools.get(toolCall.function.name);
		if (!tool) {
			return {
				content: `Unknown tool: ${toolCall.function.name}`,
				isError: true,
			};
		}

		try {
			const args = JSON.parse(toolCall.function.arguments);
			const result = await tool.fn(args, context);
			return {
				content: typeof result === "string" ? result : JSON.stringify(result),
			};
		} catch (err: any) {
			return { content: `Error: ${err.message}`, isError: true };
		}
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}
}
