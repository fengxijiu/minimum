import { McpClient } from "../../src/mcp/McpClient";
import { McpManager } from "../../src/mcp/McpManager";
import type {
	McpServerConfig,
	McpTool,
	McpToolCall,
	McpToolResult,
} from "../../src/mcp/types";

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
});
