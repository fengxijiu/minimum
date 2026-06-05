import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { MinimumMcpServer } from "../../src/mcp/server/MinimumMcpServer.js";

const cleanup: string[] = [];

async function makeProject(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minimum-mcp-server-"));
	cleanup.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("MinimumMcpServer", () => {
	it("writes plan drafts through the MCP tool surface", async () => {
		const projectRoot = await makeProject();
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const server = new MinimumMcpServer({ projectRoot, stdin, stdout });
		server.start();

		const responsePromise = readJsonLine(stdout);
		stdin.write(`${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "write_task_plan_draft",
				arguments: {
					id: "demo",
					title: "Demo",
					steps: [{ label: "Inspect", status: "next" }],
				},
			},
		})}\n`);

		const response = await responsePromise as any;
		expect(response.result.content[0].text).toContain('"ok": true');
		const raw = await fs.readFile(path.join(projectRoot, ".minimum", "plans", "drafts", "demo.json"), "utf-8");
		expect(JSON.parse(raw).title).toBe("Demo");
	});

	it("rejects GitHub write tools unless explicitly enabled", async () => {
		const projectRoot = await makeProject();
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const server = new MinimumMcpServer({ projectRoot, stdin, stdout, audit: false });
		server.start();

		const responsePromise = readJsonLine(stdout);
		stdin.write(`${JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: "github_comment_pr",
				arguments: { number: 1, body: "hello" },
			},
		})}\n`);

		const response = await responsePromise as any;
		expect(response.result.isError).toBe(true);
		expect(response.result.content[0].text).toContain("disabled by configuration");
	});

	it("returns registry config templates without installing servers", async () => {
		const projectRoot = await makeProject();
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const server = new MinimumMcpServer({ projectRoot, stdin, stdout, audit: false });
		server.start();

		const responsePromise = readJsonLine(stdout);
		stdin.write(`${JSON.stringify({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "suggest_mcp_server_config",
				arguments: { server: "minimum" },
			},
		})}\n`);

		const response = await responsePromise as any;
		const payload = JSON.parse(response.result.content[0].text);
		expect(payload.template.command).toBe("minimum-mcp-server");
		expect(payload.note).toContain("Review");
	});

	it("exposes recent audit entries as a resource", async () => {
		const projectRoot = await makeProject();
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const server = new MinimumMcpServer({ projectRoot, stdin, stdout });
		server.start();

		const writeResponse = readJsonLine(stdout);
		stdin.write(`${JSON.stringify({
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: {
				name: "validate_plan_draft",
				arguments: { draft: { title: "no steps", token: "ghp_1234567890" } },
			},
		})}\n`);
		await writeResponse;

		const readResponse = readJsonLine(stdout);
		stdin.write(`${JSON.stringify({
			jsonrpc: "2.0",
			id: 5,
			method: "resources/read",
			params: { uri: "minimum://mcp_audit" },
		})}\n`);

		const response = await readResponse as any;
		const text = response.result.contents[0].text;
		expect(text).toContain("validate_plan_draft");
		expect(text).toContain("[REDACTED]");
		expect(text).not.toContain("ghp_1234567890");
	});

	it("exposes health details as a resource", async () => {
		const projectRoot = await makeProject();
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const server = new MinimumMcpServer({ projectRoot, stdin, stdout, github: { allowWrites: false } });
		server.start();

		const readResponse = readJsonLine(stdout);
		stdin.write(`${JSON.stringify({
			jsonrpc: "2.0",
			id: 6,
			method: "resources/read",
			params: { uri: "minimum://mcp_health" },
		})}\n`);

		const response = await readResponse as any;
		const health = JSON.parse(response.result.contents[0].text);
		expect(health.server).toBe("minimum-mcp-server");
		expect(health.audit.enabled).toBe(true);
		expect(health.github.writeToolsEnabled).toBe(false);
		expect(health.resources).toContain("minimum://mcp_health");
	});
});

function readJsonLine(stream: PassThrough): Promise<unknown> {
	return new Promise((resolve) => {
		let buffer = "";
		stream.on("data", (chunk) => {
			buffer += String(chunk);
			const index = buffer.indexOf("\n");
			if (index >= 0) {
				resolve(JSON.parse(buffer.slice(0, index)));
			}
		});
	});
}
