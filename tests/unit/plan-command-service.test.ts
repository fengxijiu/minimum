import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { McpAuditLogger } from "../../src/mcp/McpAuditLogger.js";
import { afterEach, describe, expect, it } from "vitest";
import { McpCommandService } from "../../src/mcp/McpCommandService.js";
import { PlanCommandService } from "../../src/plans/PlanCommandService.js";

const cleanup: string[] = [];

async function makeProject(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minimum-plan-"));
	cleanup.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("PlanCommandService", () => {
	it("normalizes and imports MCP-written drafts", async () => {
		const projectRoot = await makeProject();
		const draftsDir = path.join(projectRoot, ".minimum", "plans", "drafts");
		await fs.mkdir(draftsDir, { recursive: true });
		await fs.writeFile(path.join(draftsDir, "demo.json"), JSON.stringify({
			title: "Demo Plan",
			steps: [
				{ label: "Inspect repo", status: "completed" },
				{ content: "Implement feature", status: "in_progress" },
				"Run verification",
			],
			source: "mcp",
		}), "utf-8");

		const service = new PlanCommandService({ projectRoot });
		const status = await service.status();
		expect(status.drafts).toHaveLength(1);
		expect(status.drafts[0]?.steps).toEqual([
			{ label: "Inspect repo", status: "done" },
			{ label: "Implement feature", status: "now" },
			{ label: "Run verification", status: "next" },
		]);

		const imported = await service.import("demo");
		expect(imported.title).toBe("Demo Plan");
		expect(imported.draft.status).toBe("imported");
	});

	it("marks malformed drafts invalid on preview", async () => {
		const projectRoot = await makeProject();
		const draftsDir = path.join(projectRoot, ".minimum", "plans", "drafts");
		await fs.mkdir(draftsDir, { recursive: true });
		await fs.writeFile(path.join(draftsDir, "broken.json"), JSON.stringify({ title: "Broken" }), "utf-8");

		const service = new PlanCommandService({ projectRoot });
		const preview = await service.preview("broken");
		expect(preview.draft.status).toBe("invalid");
		expect(preview.markdown).toContain("Errors");
	});
});

describe("McpCommandService built-ins", () => {
	it("lists built-in resources and prompts", async () => {
		const projectRoot = await makeProject();
		const service = new McpCommandService({ projectRoot });

		const resources = await service.listResources();
		expect(resources.map((resource) => resource.uri)).toEqual(expect.arrayContaining([
			"minimum://project_state",
			"minimum://skills",
			"minimum://personas",
			"minimum://task_plan_drafts",
		]));

		const prompts = service.listPrompts();
		expect(prompts.map((prompt) => prompt.name)).toContain("minimum.write_task_plan_draft");

		const projectState = await service.readResource("minimum://project_state") as Record<string, unknown>;
		expect(projectState.projectRoot).toBe(projectRoot);
	});

	it("reads recent audit events as a built-in resource", async () => {
		const projectRoot = await makeProject();
		await new McpAuditLogger(projectRoot).log({
			server: "remote",
			kind: "tool",
			name: "secret_tool",
			args: { token: "ghp_1234567890" },
			success: false,
			durationMs: 5,
			error: "Bearer abc123",
		});

		const service = new McpCommandService({ projectRoot });
		const audit = await service.readResource("minimum://mcp_audit") as { events: unknown[] };
		const text = JSON.stringify(audit);
		expect(audit.events).toHaveLength(1);
		expect(text).toContain("[REDACTED]");
		expect(text).not.toContain("ghp_1234567890");
		expect(text).not.toContain("abc123");
	});

	it("reports MCP health as a built-in resource", async () => {
		const projectRoot = await makeProject();
		const service = new McpCommandService({ projectRoot });

		const health = await service.readResource("minimum://mcp_health") as Record<string, any>;

		expect(health.projectRoot).toBe(projectRoot);
		expect(health.status).toBe("ok");
		expect(health.paths.audit).toBe(".minimum/mcp/audit.log");
		expect(health.recommendations).toContain("Check /mcp audit after exercising new servers.");
	});
});
