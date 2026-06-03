import type { Tool } from "../tools/ToolRegistry.js";
import { McpManager } from "./McpManager.js";
import { McpToolAdapter } from "./McpToolAdapter.js";
import type { McpServerConfig } from "./types.js";

export interface ConnectMcpOptions {
	/** Manager to own the connections (caller keeps it for later disconnectAll). */
	manager: McpManager;
	/** Register one adapted tool into the active tool registry. */
	register: (tool: Tool) => void;
	/** Server definitions from config (`mcpServers`). */
	servers: McpServerConfig[];
	/** Called after each server resolves (success or failure) with running totals. */
	onProgress?: (ready: number, total: number) => void;
	/** Per-server connect timeout. A hung server is skipped, not fatal. Default 10s. */
	connectTimeoutMs?: number;
}

export interface ConnectMcpResult {
	connected: string[];
	failed: Array<{ name: string; error: string }>;
	toolCount: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms connecting ${label}`)), ms);
		p.then(
			(v) => { clearTimeout(timer); resolve(v); },
			(e) => { clearTimeout(timer); reject(e); },
		);
	});
}

/**
 * Connect every configured MCP server and register its tools.
 *
 * Resilient by design: a server that fails or hangs is recorded in `failed`
 * and skipped — it never aborts startup or the other servers. Tools are
 * registered under `mcp__<server>__<tool>` to avoid name collisions.
 */
export async function connectMcpServers(opts: ConnectMcpOptions): Promise<ConnectMcpResult> {
	const { manager, register, servers } = opts;
	const total = servers.length;
	const timeout = opts.connectTimeoutMs ?? 10_000;
	const result: ConnectMcpResult = { connected: [], failed: [], toolCount: 0 };
	if (total === 0) return result;

	let done = 0;
	for (const server of servers) {
		try {
			await withTimeout(manager.addServer(server), timeout, server.name);
			result.connected.push(server.name);
		} catch (e) {
			result.failed.push({ name: server.name, error: String((e as Error)?.message ?? e) });
		}
		done++;
		opts.onProgress?.(result.connected.length, total);
	}

	// Register tools only for servers that connected successfully.
	for (const tool of manager.getAllTools()) {
		register(new McpToolAdapter(manager, tool.server, tool));
		result.toolCount++;
	}

	return result;
}
