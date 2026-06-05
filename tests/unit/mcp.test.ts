import { McpClient } from "../../src/mcp/McpClient";
import { McpManager } from "../../src/mcp/McpManager";
import { connectMcpServers } from "../../src/mcp/connectMcpServers";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	McpServerConfig,
	McpTool,
	McpToolCall,
	McpToolResult,
} from "../../src/mcp/types";

const cleanupDirs: string[] = [];

async function makeProject(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minimum-mcp-audit-"));
	cleanupDirs.push(dir);
	return dir;
}

// Mock child_process
vi.mock("child_process", () => {
	const mockProcess = {
		stdout: {
			on: vi.fn(),
		},
		stderr: {
			on: vi.fn(),
		},
		stdin: {
			write: vi.fn(),
		},
		on: vi.fn(),
		kill: vi.fn(),
	};

	return {
		spawn: vi.fn(() => mockProcess),
	};
});

describe("McpClient", () => {
	let client: McpClient;
	let config: McpServerConfig;

	beforeEach(() => {
		config = {
			name: "test-server",
			command: "test-command",
			args: ["--arg1"],
			transport: "stdio",
		};
		client = new McpClient(config);
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllGlobals();
	});

	it("should create client with config", () => {
		expect(client).toBeDefined();
		expect(client.isConnected()).toBe(false);
	});

	it("should return empty tools when not connected", () => {
		const tools = client.getTools();
		expect(tools).toEqual([]);
	});

	it("should return empty resources when not connected", () => {
		const resources = client.getResources();
		expect(resources).toEqual([]);
	});

	it("should return empty prompts when not connected", () => {
		const prompts = client.getPrompts();
		expect(prompts).toEqual([]);
	});

	it("should disconnect when not connected", async () => {
		await client.disconnect();
		expect(client.isConnected()).toBe(false);
	});

	it("filters remote tools through the configured allowlist and expands headers", async () => {
		process.env.GITHUB_TOKEN = "secret-token";
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body)) as { method: string; id: number };
			if (request.method === "initialize") {
				expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }), { status: 200 });
			}
			if (request.method === "tools/list") {
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					id: request.id,
					result: {
						tools: [
							{ name: "allowed", description: "ok", inputSchema: {} },
							{ name: "blocked", description: "no", inputSchema: {} },
						],
					},
				}), { status: 200 });
			}
			if (request.method === "resources/list") {
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { resources: [] } }), { status: 200 });
			}
			if (request.method === "prompts/list") {
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { prompts: [] } }), { status: 200 });
			}
			if (request.method === "tools/call") {
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "ok" }] } }), { status: 200 });
			}
			throw new Error(`unexpected method: ${request.method}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const remoteClient = new McpClient({
			name: "remote",
			transport: "http",
			url: "https://example.com/mcp",
			headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
			tools: ["allowed"],
		});
		await remoteClient.connect();

		expect(remoteClient.getTools().map((tool) => tool.name)).toEqual(["allowed"]);
		const blocked = await remoteClient.callTool({ name: "blocked", arguments: {} });
		expect(blocked.isError).toBe(true);
		expect(blocked.content[0]?.text).toContain("Tool not allowed");
	});

	it("expands environment placeholders in remote URLs", async () => {
		process.env.MCP_HOST = "example.com";
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			expect(url).toBe("https://example.com/mcp");
			const request = JSON.parse(String(init?.body)) as { method: string; id: number };
			const result = request.method === "tools/list"
				? { tools: [] }
				: request.method === "resources/list"
					? { resources: [] }
					: request.method === "prompts/list"
						? { prompts: [] }
						: { ok: true };
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const remoteClient = new McpClient({
			name: "remote-env",
			transport: "http",
			url: "https://${MCP_HOST}/mcp",
		});
		await remoteClient.connect();

		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("carries streamable HTTP session ids and applies denyTools", async () => {
		const seenSessionHeaders: Array<string | null> = [];
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string>;
			seenSessionHeaders.push(headers["mcp-session-id"] ?? null);
			const request = JSON.parse(String(init?.body)) as { method: string; id: number };
			if (request.method === "initialize") {
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }), {
					status: 200,
					headers: { "mcp-session-id": "session-123" },
				});
			}
			if (request.method === "tools/list") {
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					id: request.id,
					result: { tools: [{ name: "visible", description: "ok", inputSchema: {} }, { name: "denied", description: "no", inputSchema: {} }] },
				}), { status: 200 });
			}
			if (request.method === "resources/list") {
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { resources: [] } }), { status: 200 });
			}
			if (request.method === "prompts/list") {
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { prompts: [] } }), { status: 200 });
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [] } }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const remoteClient = new McpClient({
			name: "streamable",
			transport: "http",
			url: "https://example.com/mcp",
			denyTools: ["denied"],
		});
		await remoteClient.connect();

		expect(remoteClient.getTools().map((tool) => tool.name)).toEqual(["visible"]);
		expect(seenSessionHeaders[0]).toBeNull();
		expect(seenSessionHeaders.slice(1)).toContain("session-123");
		const denied = await remoteClient.callTool({ name: "denied", arguments: {} });
		expect(denied.isError).toBe(true);
	});

	it("connects legacy SSE servers through endpoint negotiation", async () => {
		const encoder = new TextEncoder();
		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
		const emit = (event: string, data: unknown) => {
			const payload = typeof data === "string" ? data : JSON.stringify(data);
			streamController?.enqueue(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
		};
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (init?.method === "GET") {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						streamController = controller;
						controller.enqueue(encoder.encode("event: endpoint\ndata: /messages?sessionId=abc\n\n"));
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}

			expect(url).toBe("http://localhost/messages?sessionId=abc");
			const request = JSON.parse(String(init?.body)) as { method: string; id: number };
			if (request.method === "initialize") {
				emit("message", { jsonrpc: "2.0", id: request.id, result: { ok: true } });
			} else if (request.method === "tools/list") {
				emit("message", {
					jsonrpc: "2.0",
					id: request.id,
					result: { tools: [{ name: "echo", description: "Echo", inputSchema: {} }] },
				});
			} else if (request.method === "resources/list") {
				emit("message", { jsonrpc: "2.0", id: request.id, result: { resources: [] } });
			} else if (request.method === "prompts/list") {
				emit("message", { jsonrpc: "2.0", id: request.id, result: { prompts: [] } });
			} else if (request.method === "tools/call") {
				emit("message", {
					jsonrpc: "2.0",
					id: request.id,
					result: { content: [{ type: "text", text: "pong" }] },
				});
			}
			return new Response("", { status: 202 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const sseClient = new McpClient({
			name: "legacy-sse",
			transport: "sse",
			url: "http://localhost/sse",
		});

		await sseClient.connect();
		expect(sseClient.isConnected()).toBe(true);
		expect(sseClient.getTools().map((tool) => tool.name)).toEqual(["echo"]);
		const result = await sseClient.callTool({ name: "echo", arguments: {} });
		expect(result.content[0]?.text).toBe("pong");
		await sseClient.disconnect();
	});
});

describe("McpManager", () => {
	let manager: McpManager;

	beforeEach(() => {
		manager = new McpManager();
	});

	it("should create manager", () => {
		expect(manager).toBeDefined();
	});

	it("should list empty servers initially", () => {
		const servers = manager.listServers();
		expect(servers).toEqual([]);
	});

	it("should return empty tools initially", () => {
		const tools = manager.getAllTools();
		expect(tools).toEqual([]);
	});

	it("should return undefined for unknown client", () => {
		const client = manager.getClient("unknown");
		expect(client).toBeUndefined();
	});

	it("should return error when calling tool on unknown server", async () => {
		const toolCall: McpToolCall = {
			name: "test-tool",
			arguments: { arg1: "value1" },
		};

		const result = await manager.callTool("unknown", toolCall);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Server not found");
	});

	it("should disconnect all when no clients", async () => {
		await manager.disconnectAll();
		expect(manager.listServers()).toEqual([]);
	});

	it("writes audit log entries without leaking secrets when enabled", async () => {
		const projectRoot = await makeProject();
		const audited = new McpManager({ projectRoot, audit: true });

		await audited.callTool("missing", {
			name: "secret_tool",
			arguments: { Authorization: "Bearer abc123", token: "ghp_1234567890" },
		});

		const audit = await fs.readFile(path.join(projectRoot, ".minimum", "mcp", "audit.log"), "utf-8");
		expect(audit).toContain('"server":"missing"');
		expect(audit).toContain('"success":false');
		expect(audit).toContain("[REDACTED]");
		expect(audit).not.toContain("ghp_1234567890");
		expect(audit).not.toContain("abc123");
	});

	it("captures failed server details without exposing header values", async () => {
		const fakeManager = {
			addServer: vi.fn(async () => {
				throw new Error("boom");
			}),
			getAllTools: vi.fn(() => []),
			getServerDetails: vi.fn(() => []),
		};

		const result = await connectMcpServers({
			manager: fakeManager as any,
			register: vi.fn(),
			servers: [{
				name: "remote",
				transport: "http",
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer ${TOKEN}" },
				tools: ["repo_info"],
			}],
		});

		expect(result.failedDetails).toEqual([{
			name: "remote",
			transport: "http",
			url: "https://example.com/mcp",
			headerKeys: ["Authorization"],
			allowedTools: ["repo_info"],
			error: "boom",
		}]);
	});
});

afterEach(async () => {
	await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
