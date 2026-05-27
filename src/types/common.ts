export interface ChatMessage {
	role: string;
	content: string;
	tool_calls?: any[];
	tool_call_id?: string;
	reasoning_content?: string;
}

export interface ToolDefinition {
	name: string;
	description?: string;
	parameters?: Record<string, any>;
	fn?: (args: any, ctx?: any) => any;
}

export interface ToolCall {
	id?: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface ToolResult {
	content: string;
	isError?: boolean;
	metadata?: Record<string, any>;
}

export interface SourceLocation {
	file: string;
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
}
