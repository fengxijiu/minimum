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
	private sseAbort: AbortController | null = null;
	private ssePostUrl: string | null = null;
	private sseEndpointResolve: ((url: string) => void) | null = null;
	private sseEndpointReject: ((reason: unknown) => void) | null = null;
	private httpSessionId: string | null = null;
	private catalogLoadedAt = 0;

	constructor(config: McpServerConfig) {
		this.config = config;
	}

	async connect(): Promise<void> {
		if (this.connected) {
			return;
		}

		if (this.config.transport === "stdio") {
			return new Promise((resolve, reject) => {
				try {
					if (!this.config.command) {
						reject(new Error(`stdio MCP server "${this.config.name}" requires a command`));
						return;
					}
					this.process = spawn(expandEnvVars(this.config.command), resolveArgs(this.config.args), {
						env: { ...process.env, ...resolveEnv(this.config.env) },
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

		if (this.config.transport === "sse") {
			await this.connectSse();
		}

		await this.initialize();
		this.connected = true;
	}

	private async connectSse(): Promise<void> {
		if (!this.config.url) {
			throw new Error(`SSE MCP server "${this.config.name}" requires a url`);
		}

		this.sseAbort = new AbortController();
		const url = expandEnvVars(this.config.url);
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Accept: "text/event-stream",
				...resolveHeaders(this.config.headers),
				...this.sessionHeaders(),
			},
			signal: this.sseAbort.signal,
		});

		if (!response.ok || !response.body) {
			throw new Error(`MCP SSE ${response.status}: ${response.statusText}`);
		}

		const endpoint = new Promise<string>((resolve, reject) => {
			this.sseEndpointResolve = resolve;
			this.sseEndpointReject = reject;
		});
		void this.readSseStream(response.body).catch((error) => {
			this.rejectPendingRequests(error);
			this.sseEndpointReject?.(error);
		});
		this.ssePostUrl = await withTimeout(endpoint, 30_000, "SSE endpoint");
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

		if (this.config.transport === "stdio") {
			return new Promise((resolve, reject) => {
				this.pendingRequests.set(id, { resolve, reject });

				const data = `${JSON.stringify(request)}\n`;
				this.process?.stdin?.write(data);

				setTimeout(() => {
					if (this.pendingRequests.has(id)) {
						this.pendingRequests.delete(id);
						reject(new Error(`Request timeout: ${method}`));
					}
				}, 30000);
			});
		}

		if (this.config.transport === "sse") {
			return this.sendSseRequest(request, method);
		}

		const response = await this.sendRemoteRequest(request);
		if (response.error) {
			throw new Error(response.error.message);
		}
		return response.result;
	}

	private async sendSseRequest(request: McpRequest, method: string): Promise<any> {
		if (!this.ssePostUrl) {
			throw new Error(`SSE MCP server "${this.config.name}" did not provide a message endpoint`);
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pendingRequests.has(request.id)) {
					this.pendingRequests.delete(request.id);
					reject(new Error(`Request timeout: ${method}`));
				}
			}, 30000);

			this.pendingRequests.set(request.id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (reason) => {
					clearTimeout(timer);
					reject(reason);
				},
			});

			void fetch(this.ssePostUrl!, {
				method: "POST",
				headers: {
					Accept: "application/json, text/event-stream",
					"Content-Type": "application/json",
					...resolveHeaders(this.config.headers),
					...this.sessionHeaders(),
				},
				body: JSON.stringify(request),
			}).then(async (response) => {
				if (!response.ok) {
					this.pendingRequests.delete(request.id);
					clearTimeout(timer);
					const text = await response.text().catch(() => "");
					reject(new Error(`MCP SSE POST ${response.status}: ${text || response.statusText}`));
					return;
				}

				const text = await response.text().catch(() => "");
				if (text.trim()) {
					this.handleResponse(parseRemoteResponse(text, response.headers.get("content-type"), request.id));
				}
			}).catch((error) => {
				this.pendingRequests.delete(request.id);
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	private async sendRemoteRequest(request: McpRequest): Promise<McpResponse> {
		if (!this.config.url) {
			throw new Error(`remote MCP server "${this.config.name}" requires a url`);
		}

		const response = await fetch(expandEnvVars(this.config.url), {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				...resolveHeaders(this.config.headers),
				...this.sessionHeaders(),
			},
			body: JSON.stringify(request),
		});
		this.captureSessionId(response);

		const text = await response.text();
		if (!response.ok) {
			throw new Error(`MCP HTTP ${response.status}: ${text || response.statusText}`);
		}

		return parseRemoteResponse(
			text,
			response.headers.get("content-type"),
			request.id,
		);
	}

	private async initialize(): Promise<void> {
		await this.sendRequest("initialize", {
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

		try {
			const toolsResult = await this.sendRequest("tools/list");
			this.tools = filterTools(toolsResult?.tools || [], this.config.tools, this.config.denyTools);
		} catch {
			this.tools = [];
		}

		try {
			const resourcesResult = await this.sendRequest("resources/list");
			this.resources = resourcesResult?.resources || [];
		} catch {
			this.resources = [];
		}

		try {
			const promptsResult = await this.sendRequest("prompts/list");
			this.prompts = promptsResult?.prompts || [];
		} catch {
			this.prompts = [];
		}
		this.catalogLoadedAt = Date.now();
	}

	async callTool(toolCall: McpToolCall): Promise<McpToolResult> {
		if (!isToolAllowed(toolCall.name, this.config.tools, this.config.denyTools)) {
			return {
				content: [{ type: "text", text: `Tool not allowed by config: ${toolCall.name}` }],
				isError: true,
			};
		}
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
		void this.refreshCatalogIfStale();
		return [...this.resources];
	}

	getPrompts(): McpPrompt[] {
		void this.refreshCatalogIfStale();
		return [...this.prompts];
	}

	isConnected(): boolean {
		return this.connected;
	}

	async disconnect(): Promise<void> {
		if (this.process) {
			this.process.kill();
			this.process = null;
		}
		this.sseAbort?.abort();
		this.sseAbort = null;
		this.ssePostUrl = null;
		this.rejectPendingRequests(new Error("MCP client disconnected"));
		this.connected = false;
	}

	private async refreshCatalogIfStale(): Promise<void> {
		const ttl = this.config.cacheTtlMs;
		if (!ttl || !this.connected || Date.now() - this.catalogLoadedAt < ttl) return;
		try {
			await this.initialize();
		} catch {
			// Cache refresh is best-effort; callers still get the last known catalog.
		}
	}

	private sessionHeaders(): Record<string, string> {
		return this.httpSessionId ? { "mcp-session-id": this.httpSessionId } : {};
	}

	private captureSessionId(response: Response): void {
		const id = response.headers.get("mcp-session-id");
		if (id) this.httpSessionId = id;
	}

	private rejectPendingRequests(error: unknown): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	private async readSseStream(body: ReadableStream<Uint8Array>): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let splitAt = findSseEventBoundary(buffer);
			while (splitAt >= 0) {
				const rawEvent = buffer.slice(0, splitAt);
				buffer = buffer.slice(skipSseEventBoundary(buffer, splitAt));
				this.handleSseEvent(parseSseEvent(rawEvent));
				splitAt = findSseEventBoundary(buffer);
			}
		}

		buffer += decoder.decode();
		if (buffer.trim()) {
			this.handleSseEvent(parseSseEvent(buffer));
		}
	}

	private handleSseEvent(event: SseEvent): void {
		if (!event.data) return;
		if (event.event === "endpoint") {
			if (!this.config.url) return;
			this.sseEndpointResolve?.(new URL(event.data, expandEnvVars(this.config.url)).toString());
			this.sseEndpointResolve = null;
			this.sseEndpointReject = null;
			return;
		}
		if (event.event !== "message") return;

		try {
			const parsed = JSON.parse(event.data) as McpResponse | McpResponse[];
			if (Array.isArray(parsed)) {
				for (const response of parsed) this.handleResponse(response);
			} else {
				this.handleResponse(parsed);
			}
		} catch (error) {
			console.error("Failed to parse MCP SSE message:", error);
		}
	}
}

interface SseEvent {
	event: string;
	data: string;
}

function filterTools(tools: McpTool[], allowlist?: string[], denylist?: string[]): McpTool[] {
	return tools.filter((tool) => isToolAllowed(tool.name, allowlist, denylist));
}

function isToolAllowed(name: string, allowlist?: string[], denylist?: string[]): boolean {
	if (denylist?.includes(name)) return false;
	return !allowlist?.length || allowlist.includes(name);
}

function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	if (!headers) return {};
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [key, expandEnvVars(value)]),
	);
}

function resolveArgs(args: string[] | undefined): string[] {
	return (args ?? []).map((arg) => expandEnvVars(arg));
}

function resolveEnv(env: Record<string, string> | undefined): Record<string, string> {
	if (!env) return {};
	return Object.fromEntries(
		Object.entries(env).map(([key, value]) => [key, expandEnvVars(value)]),
	);
}

function expandEnvVars(value: string): string {
	return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
		if (name === "PWD" || name === "CWD") return process.cwd();
		return process.env[name] ?? "";
	});
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function parseSseEvent(raw: string): SseEvent {
	let event = "message";
	const data: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line || line.startsWith(":")) continue;
		const sep = line.indexOf(":");
		const field = sep >= 0 ? line.slice(0, sep) : line;
		const value = sep >= 0 ? line.slice(sep + 1).replace(/^ /, "") : "";
		if (field === "event") event = value || "message";
		if (field === "data") data.push(value);
	}
	return { event, data: data.join("\n") };
}

function findSseEventBoundary(buffer: string): number {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	if (lf < 0) return crlf;
	if (crlf < 0) return lf;
	return Math.min(lf, crlf);
}

function skipSseEventBoundary(buffer: string, splitAt: number): number {
	return buffer.startsWith("\r\n\r\n", splitAt) ? splitAt + 4 : splitAt + 2;
}

function parseRemoteResponse(
	text: string,
	contentType: string | null,
	id: number | string,
): McpResponse {
	const trimmed = text.trim();
	if (!trimmed) {
		throw new Error("empty MCP response");
	}

	if (contentType?.includes("text/event-stream") || trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
		const responses = extractSsePayloads(trimmed);
		const match = responses.find((response) => response.id === id) ?? responses[responses.length - 1];
		if (!match) throw new Error("no JSON-RPC payload found in SSE response");
		return match;
	}

	const parsed = JSON.parse(trimmed) as McpResponse | McpResponse[];
	if (Array.isArray(parsed)) {
		const match = parsed.find((response) => response.id === id) ?? parsed[parsed.length - 1];
		if (!match) throw new Error("no JSON-RPC payload found in response array");
		return match;
	}
	return parsed;
}

function extractSsePayloads(text: string): McpResponse[] {
	const chunks = text.split(/\r?\n\r?\n/);
	const out: McpResponse[] = [];
	for (const chunk of chunks) {
		const dataLines = chunk
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.filter(Boolean);
		for (const data of dataLines) {
			if (data === "[DONE]") continue;
			try {
				const parsed = JSON.parse(data) as McpResponse | McpResponse[];
				if (Array.isArray(parsed)) out.push(...parsed);
				else out.push(parsed);
			} catch {
				continue;
			}
		}
	}
	return out;
}
