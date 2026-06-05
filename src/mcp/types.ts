export interface McpServerConfig {
	name: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	transport: "stdio" | "sse" | "http";
	url?: string;
	headers?: Record<string, string>;
	tools?: string[];
	denyTools?: string[];
	cacheTtlMs?: number;
}

export interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, any>;
}

export interface McpResource {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
}

export interface McpPrompt {
	name: string;
	description?: string;
	arguments?: Array<{
		name: string;
		description?: string;
		required?: boolean;
	}>;
}

export interface McpListedResource extends McpResource {
	server: string;
}

export interface McpListedPrompt extends McpPrompt {
	server: string;
}

export interface McpServerDetails {
	name: string;
	transport: "stdio" | "sse" | "http";
	url?: string;
	headerKeys: string[];
	allowedTools?: string[];
	deniedTools?: string[];
	toolNames: string[];
	toolCount: number;
	resourceCount: number;
	promptCount: number;
}

export interface McpFailedServerDetails {
	name: string;
	transport: "stdio" | "sse" | "http";
	url?: string;
	headerKeys: string[];
	allowedTools?: string[];
	deniedTools?: string[];
	error: string;
}

export interface McpRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: any;
}

export interface McpResponse {
	jsonrpc: "2.0";
	id: number | string;
	result?: any;
	error?: {
		code: number;
		message: string;
		data?: any;
	};
}

export interface McpToolCall {
	name: string;
	arguments: Record<string, any>;
}

export interface McpToolResult {
	content: Array<{
		type: "text" | "image" | "resource";
		text?: string;
		data?: string;
		mimeType?: string;
	}>;
	isError?: boolean;
}
