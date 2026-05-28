import { type ChildProcess, spawn } from "node:child_process";
import type {
	McpPrompt,
	McpRequest,
	McpResource,
	McpResponse,
	McpServerConfig,
	McpTool,
	McpToolCall,
	McpToolResult,
} from "./types.js";

export class McpClient {
	private config: McpServerConfig;
	private process: ChildProcess | null = null;
	private requestId = 0;
	private pendingRequests: Map<
		number | string,
		{
			resolve: (value: any) => void;
			reject: (reason: any) => void;
		}
	> = new Map();
	private buffer = "";
	private connected = false;
	private tools: McpTool[] = [];
	private resources: McpResource[] = [];
	private prompts: McpPrompt[] = [];

	constructor(config: McpServerConfig) {
		this.config = config;
	}

	async connect(): Promise<void> {
		if (this.connected) {
			return;
		}

		return new Promise((resolve, reject) => {
			try {
				this.process = spawn(this.config.command, this.config.args || [], {
					env: { ...process.env, ...this.config.env },
					stdio: ["pipe", "pipe", "pipe"],
				});

				this.process.stdout?.on("data", (data: Buffer) => {
					this.buffer += data.toString();
					this.processBuffer();
				});

				this.process.stderr?.on("data", (data: Buffer) => {
					console.error(`MCP stderr: ${data.toString()}`);
				});

				this.process.on("error", (error) => {
					reject(error);
				});

				this.process.on("exit", (code) => {
					this.connected = false;
					if (code !== 0 && code !== null) {
						console.error(`MCP process exited with code ${code}`);
					}
				});

				// 初始化
				this.initialize()
					.then(() => {
						this.connected = true;
						resolve();
					})
					.catch(reject);
			} catch (error) {
				reject(error);
			}
		});
	}

	private processBuffer(): void {
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() || "";

		for (const line of lines) {
			if (line.trim()) {
				try {
					const response = JSON.parse(line) as McpResponse;
					this.handleResponse(response);
				} catch (error) {
					console.error("Failed to parse MCP response:", error);
				}
			}
		}
	}

	private handleResponse(response: McpResponse): void {
		const pending = this.pendingRequests.get(response.id);
		if (pending) {
			this.pendingRequests.delete(response.id);
			if (response.error) {
				pending.reject(new Error(response.error.message));
			} else {
				pending.resolve(response.result);
			}
		}
	}

	private async sendRequest(method: string, params?: any): Promise<any> {
		const id = ++this.requestId;
		const request: McpRequest = {
			jsonrpc: "2.0",
			id,
			method,
			params,
		};

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });

			const data = `${JSON.stringify(request)}\n`;
			this.process?.stdin?.write(data);

			// 超时处理
			setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id);
					reject(new Error(`Request timeout: ${method}`));
				}
			}, 30000);
		});
	}

	private async initialize(): Promise<void> {
		const result = await this.sendRequest("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {
				tools: {},
				resources: {},
				prompts: {},
			},
			clientInfo: {
				name: "minimum",
				version: "1.0.0",
			},
		});

		// 获取工具列表
		try {
			const toolsResult = await this.sendRequest("tools/list");
			this.tools = toolsResult?.tools || [];
		} catch {
			this.tools = [];
		}

		// 获取资源列表
		try {
			const resourcesResult = await this.sendRequest("resources/list");
			this.resources = resourcesResult?.resources || [];
		} catch {
			this.resources = [];
		}

		// 获取提示列表
		try {
			const promptsResult = await this.sendRequest("prompts/list");
			this.prompts = promptsResult?.prompts || [];
		} catch {
			this.prompts = [];
		}
	}

	async callTool(toolCall: McpToolCall): Promise<McpToolResult> {
		return this.sendRequest("tools/call", {
			name: toolCall.name,
			arguments: toolCall.arguments,
		});
	}

	async readResource(uri: string): Promise<any> {
		return this.sendRequest("resources/read", { uri });
	}

	async getPrompt(name: string, args?: Record<string, any>): Promise<any> {
		return this.sendRequest("prompts/get", { name, arguments: args });
	}

	getTools(): McpTool[] {
		return [...this.tools];
	}

	getResources(): McpResource[] {
		return [...this.resources];
	}

	getPrompts(): McpPrompt[] {
		return [...this.prompts];
	}

	isConnected(): boolean {
		return this.connected;
	}

	async disconnect(): Promise<void> {
		if (this.process) {
			this.process.kill();
			this.process = null;
			this.connected = false;
		}
	}
}
