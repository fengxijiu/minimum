import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadLearnedSkills } from "../../skills/LearnedSkillLoader.js";
import { listPersonas } from "../../personas/index.js";
import { McpAuditLogger, readRecentAuditEvents } from "../McpAuditLogger.js";
import { PlanDraftStore, assertSafeDraftId } from "../../plans/PlanDraftStore.js";
import { normalizePlanDraft } from "../../plans/PlanCommandService.js";
import type { PlanDraft } from "../../plans/types.js";
import type { McpPrompt, McpRequest, McpResource, McpResponse, McpTool } from "../types.js";
import { callGitHubTool, GITHUB_READ_TOOL_NAMES, GITHUB_TOOL_NAMES, GITHUB_WRITE_TOOL_NAMES, type GitHubWritePolicy } from "./GitHubCliTools.js";

export interface MinimumMcpServerOptions {
	projectRoot: string;
	stdin?: NodeJS.ReadableStream;
	stdout?: NodeJS.WritableStream;
	audit?: boolean;
	github?: GitHubWritePolicy;
}

const SERVER_INFO = { name: "minimum-mcp-server", version: "0.1.0" };

export class MinimumMcpServer {
	private buffer = "";
	private readonly projectRoot: string;
	private readonly stdin: NodeJS.ReadableStream;
	private readonly stdout: NodeJS.WritableStream;
	private readonly draftStore: PlanDraftStore;
	private readonly auditLogger?: McpAuditLogger;
	private readonly githubWritePolicy: GitHubWritePolicy;

	constructor(options: MinimumMcpServerOptions) {
		this.projectRoot = options.projectRoot;
		this.stdin = options.stdin ?? process.stdin;
		this.stdout = options.stdout ?? process.stdout;
		this.draftStore = new PlanDraftStore(this.projectRoot);
		this.auditLogger = options.audit === false ? undefined : new McpAuditLogger(this.projectRoot);
		this.githubWritePolicy = options.github ?? {};
	}

	start(): void {
		this.stdin.setEncoding("utf-8");
		this.stdin.on("data", (chunk) => {
			this.buffer += String(chunk);
			this.processBuffer();
		});
	}

	private processBuffer(): void {
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			void this.handleLine(trimmed);
		}
	}

	private async handleLine(line: string): Promise<void> {
		let request: McpRequest;
		try {
			request = JSON.parse(line) as McpRequest;
		} catch (error) {
			this.write({ jsonrpc: "2.0", id: 0, error: { code: -32700, message: String((error as Error).message) } });
			return;
		}

		try {
			const result = await this.dispatch(request.method, request.params);
			this.write({ jsonrpc: "2.0", id: request.id, result });
		} catch (error) {
			this.write({
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32000, message: String((error as Error)?.message ?? error) },
			});
		}
	}

	private async dispatch(method: string, params: any): Promise<unknown> {
		switch (method) {
			case "initialize":
				return {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {}, resources: {}, prompts: {} },
					serverInfo: SERVER_INFO,
				};
			case "tools/list":
				return { tools: this.listTools() };
			case "tools/call":
				return this.callTool(params?.name, params?.arguments ?? {});
			case "resources/list":
				return { resources: this.listResources() };
			case "resources/read":
				return this.readResource(params?.uri);
			case "prompts/list":
				return { prompts: this.listPrompts() };
			case "prompts/get":
				return this.getPrompt(params?.name, params?.arguments ?? {});
			default:
				throw new Error(`Unsupported MCP method: ${method}`);
		}
	}

	private listTools(): McpTool[] {
		return [
			{
				name: "read_project_state",
				description: "Read a bounded JSON snapshot of the current Minimum project state.",
				inputSchema: { type: "object", properties: {} },
			},
			{
				name: "write_task_plan_draft",
				description: "Write a task plan draft to .minimum/plans/drafts for TUI review/import.",
				inputSchema: {
					type: "object",
					properties: {
						id: { type: "string" },
						title: { type: "string" },
						steps: {
							type: "array",
							items: {
								type: "object",
								properties: {
									label: { type: "string" },
									status: { type: "string", enum: ["done", "now", "next", "completed", "in_progress", "pending"] },
								},
								required: ["label"],
							},
						},
					},
					required: ["title", "steps"],
				},
			},
			{
				name: "query_persona",
				description: "Read one persona profile by id.",
				inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
			},
			{
				name: "list_skills",
				description: "List learned Minimum skills available in this project.",
				inputSchema: { type: "object", properties: {} },
			},
			{
				name: "validate_plan_draft",
				description: "Validate a plan draft shape without importing it.",
				inputSchema: { type: "object", properties: { draft: { type: "object" } }, required: ["draft"] },
			},
			{
				name: "suggest_mcp_server_config",
				description: "Return a reviewed MCP server config template for a trusted registry source. Does not install anything.",
				inputSchema: {
					type: "object",
					properties: {
						server: { type: "string", enum: ["minimum", "github", "filesystem"] },
					},
					required: ["server"],
				},
			},
			...GITHUB_TOOL_NAMES.map((name) => ({
				name,
				description: GITHUB_WRITE_TOOL_NAMES.includes(name as any)
					? `Write-capable GitHub CLI tool, disabled unless explicitly configured: ${name}`
					: `Read-only GitHub CLI tool: ${name}`,
				inputSchema: { type: "object", properties: {} },
			})),
		];
	}

	private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		const started = Date.now();
		try {
			const result = await this.callToolInner(name, args);
			const isError = isToolError(result);
			await this.audit("tool", name, args, !isError, Date.now() - started, isError ? extractToolText(result) : undefined);
			return result;
		} catch (error) {
			await this.audit("tool", name, args, false, Date.now() - started, String((error as Error)?.message ?? error));
			throw error;
		}
	}

	private async callToolInner(name: string, args: Record<string, unknown>): Promise<unknown> {
		if (GITHUB_TOOL_NAMES.includes(name as any)) {
			return callGitHubTool(name, args, this.projectRoot, this.githubWritePolicy);
		}

		switch (name) {
			case "read_project_state":
				return textContent(await this.projectState());
			case "write_task_plan_draft":
				return textContent(await this.writeTaskPlanDraft(args));
			case "query_persona":
				return textContent(this.queryPersona(String(args.id ?? "")));
			case "list_skills":
				return textContent(await this.skillsState());
			case "validate_plan_draft":
				return textContent(this.validatePlanDraft(args.draft));
			case "suggest_mcp_server_config":
				return textContent(suggestMcpServerConfig(String(args.server ?? "")));
			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	}

	private listResources(): McpResource[] {
		return [
			{ uri: "minimum://project_state", name: "project_state", mimeType: "application/json" },
			{ uri: "minimum://skills", name: "skills", mimeType: "application/json" },
			{ uri: "minimum://personas", name: "personas", mimeType: "application/json" },
			{ uri: "minimum://task_plan_drafts", name: "task_plan_drafts", mimeType: "application/json" },
			{ uri: "minimum://mcp_registry", name: "mcp_registry", mimeType: "application/json" },
			{ uri: "minimum://mcp_health", name: "mcp_health", mimeType: "application/json" },
			{ uri: "minimum://mcp_audit", name: "mcp_audit", mimeType: "application/json" },
		];
	}

	private async readResource(uri: string): Promise<unknown> {
		const payload = uri === "minimum://project_state"
			? await this.projectState()
			: uri === "minimum://skills"
				? await this.skillsState()
				: uri === "minimum://personas"
					? this.personasState()
					: uri === "minimum://task_plan_drafts"
						? await this.planDraftsState()
						: uri === "minimum://mcp_registry"
							? registryState()
							: uri === "minimum://mcp_health"
								? this.healthState()
								: uri === "minimum://mcp_audit"
									? await this.auditState()
									: null;
		if (!payload) throw new Error(`Unknown resource: ${uri}`);
		return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] };
	}

	private listPrompts(): McpPrompt[] {
		return [
			{ name: "assign_persona", description: "Choose suitable Minimum personas for a task." },
			{ name: "validate_task", description: "Validate that a task is ready for execution." },
			{ name: "repair_plan", description: "Repair a weak or invalid task plan." },
			{ name: "github-pr-review", description: "Review a GitHub PR using read-only GitHub tools." },
			{ name: "github-fix-ci", description: "Diagnose failing GitHub CI with gh-backed read-only tools." },
			{ name: "github-address-comments", description: "Plan responses to GitHub review comments." },
			{ name: "github-create-pr", description: "Draft a PR workflow; write actions require explicit approval elsewhere." },
			{ name: "github-release-notes", description: "Draft release notes from GitHub repository state." },
		];
	}

	private getPrompt(name: string, args: Record<string, unknown>): unknown {
		const task = typeof args.task === "string" ? args.task : "";
		const prompts: Record<string, string> = {
			assign_persona: `Given this task, choose Minimum personas and explain why.\n\nTask: ${task}`,
			validate_task: `Validate whether this task is specific, bounded, and testable.\n\nTask: ${task}`,
			repair_plan: `Repair this plan into concise ordered steps. Keep one active step at most.\n\nTask: ${task}`,
			"github-pr-review": "Use github_auth_status, github_repo_info, and github_pr_view before producing review findings.",
			"github-fix-ci": "Use github_auth_status, github_repo_info, github_pr_view, and github_ci_status before proposing a CI fix.",
			"github-address-comments": "Inspect PR context first, then draft responses and code-change plan before any write.",
			"github-create-pr": "Prepare PR title/body/checklist from repository context. Do not perform writes unless explicitly enabled.",
			"github-release-notes": "Summarize merged changes and CI state into concise release notes.",
		};
		const content = prompts[name];
		if (!content) throw new Error(`Unknown prompt: ${name}`);
		return { messages: [{ role: "user", content }] };
	}

	private async projectState(): Promise<Record<string, unknown>> {
		const [skills, drafts] = await Promise.all([loadLearnedSkills(this.projectRoot), this.planDraftsState()]);
		return {
			projectRoot: this.projectRoot,
			generatedAt: new Date().toISOString(),
			learnedSkillCount: skills.length,
			personaCount: listPersonas().length,
			planDraftCount: (drafts.drafts as unknown[]).length,
		};
	}

	private async skillsState(): Promise<Record<string, unknown>> {
		const skills = await loadLearnedSkills(this.projectRoot);
		return { skills: skills.map(({ name, description, tags, status, path }) => ({ name, description, tags, status, path })) };
	}

	private personasState(): Record<string, unknown> {
		return {
			personas: listPersonas().map((persona) => ({
				id: persona.id,
				kind: persona.kind,
				model: persona.model,
				toolAllowlist: persona.toolAllowlist,
				toolDenylist: persona.toolDenylist,
			})),
		};
	}

	private queryPersona(id: string): Record<string, unknown> {
		const persona = listPersonas().find((p) => p.id === id);
		if (!persona) throw new Error(`Unknown persona: ${id}`);
		return {
			id: persona.id,
			kind: persona.kind,
			model: persona.model,
			maxSteps: persona.maxSteps,
			maxTokens: persona.maxTokens,
			toolAllowlist: persona.toolAllowlist,
			toolDenylist: persona.toolDenylist,
			pathPolicy: persona.pathPolicy,
		};
	}

	private async planDraftsState(): Promise<Record<string, unknown>> {
		const rawDrafts = await this.draftStore.listRaw();
		const drafts = rawDrafts.map(({ id, raw }) => normalizePlanDraft(raw, id));
		return { drafts: drafts.map((draft) => ({ id: draft.id, title: draft.title, status: draft.status, steps: draft.steps.length })) };
	}

	private async auditState(): Promise<Record<string, unknown>> {
		const events = await readRecentAuditEvents(this.projectRoot, 100);
		return {
			count: events.length,
			path: ".minimum/mcp/audit.log",
			events,
		};
	}

	private healthState(): Record<string, unknown> {
		return {
			server: SERVER_INFO.name,
			version: SERVER_INFO.version,
			projectRoot: this.projectRoot,
			generatedAt: new Date().toISOString(),
			audit: {
				enabled: this.auditLogger !== undefined,
				path: ".minimum/mcp/audit.log",
			},
			github: {
				writeToolsEnabled: this.githubWritePolicy.allowWrites === true,
				allowedWriteTools: this.githubWritePolicy.allowedTools ?? [],
				writeTools: GITHUB_WRITE_TOOL_NAMES,
				readTools: GITHUB_READ_TOOL_NAMES,
			},
			resources: this.listResources().map((resource) => resource.uri),
			tools: {
				readOnly: [
					"read_project_state",
					"query_persona",
					"list_skills",
					"validate_plan_draft",
					"suggest_mcp_server_config",
					...GITHUB_READ_TOOL_NAMES,
				],
				writeGated: ["write_task_plan_draft", ...GITHUB_WRITE_TOOL_NAMES],
			},
		};
	}

	private validatePlanDraft(raw: unknown): Record<string, unknown> {
		const draft = normalizePlanDraft(raw, "preview");
		return { ok: draft.status !== "invalid", draft, errors: draft.errors ?? [] };
	}

	private async writeTaskPlanDraft(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const now = new Date().toISOString();
		const id = typeof args.id === "string" && args.id.trim()
			? args.id.trim()
			: `plan_${now.replace(/[-:.TZ]/g, "").slice(0, 14)}`;
		assertSafeDraftId(id);
		const draft = normalizePlanDraft({
			id,
			title: args.title,
			steps: args.steps,
			source: "minimum-mcp-server",
			status: "draft",
			createdAt: now,
			updatedAt: now,
		}, id);
		if (draft.status === "invalid") {
			return { ok: false, draft, errors: draft.errors ?? [] };
		}
		await this.draftStore.save(draft as PlanDraft);
		return {
			ok: true,
			id: draft.id,
			path: path.join(this.projectRoot, ".minimum", "plans", "drafts", `${draft.id}.json`),
			draft,
		};
	}

	private write(response: McpResponse): void {
		this.stdout.write(`${JSON.stringify(response)}\n`);
	}

	private async audit(
		kind: "tool" | "resource" | "prompt",
		name: string,
		args: unknown,
		success: boolean,
		durationMs: number,
		error?: string,
	): Promise<void> {
		try {
			await this.auditLogger?.log({ server: "minimum", kind, name, args, success, durationMs, ...(error ? { error } : {}) });
		} catch {
			// Auditing is best-effort.
		}
	}
}

export function startMinimumMcpServer(projectRoot = process.env.MINIMUM_PROJECT_ROOT || process.cwd()): void {
	new MinimumMcpServer({
		projectRoot,
		github: {
			allowWrites: process.env.MINIMUM_MCP_GITHUB_ALLOW_WRITES === "true",
			allowedTools: parseCsv(process.env.MINIMUM_MCP_GITHUB_ALLOWED_TOOLS),
		},
	}).start();
}

function textContent(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function registryState(): Record<string, unknown> {
	return {
		sources: [
			{ name: "official-registry", url: "https://github.com/modelcontextprotocol/registry", trusted: true },
			{ name: "official-servers", url: "https://github.com/modelcontextprotocol/servers", trusted: true },
			{ name: "github-mcp-server", url: "https://github.com/github/github-mcp-server", trusted: true },
		],
		policy: "Install registry-provided servers only after reviewing transport, headers, tools allowlist, and write capabilities.",
	};
}

function suggestMcpServerConfig(server: string): Record<string, unknown> {
	const templates: Record<string, unknown> = {
		minimum: {
			name: "minimum",
			transport: "stdio",
			command: "minimum-mcp-server",
			env: { MINIMUM_PROJECT_ROOT: "${PWD}" },
			tools: ["read_project_state", "write_task_plan_draft", "query_persona", "list_skills", "validate_plan_draft"],
			denyTools: ["github_create_pr_draft", "github_comment_pr"],
		},
		github: {
			name: "github",
			transport: "stdio",
			command: "github-mcp-server",
			env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
			tools: ["github_auth_status", "github_repo_info", "github_list_prs", "github_pr_view", "github_issue_view", "github_ci_status"],
			denyTools: ["github_create_pr_draft", "github_comment_pr"],
		},
		filesystem: {
			name: "filesystem",
			transport: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem", "${PWD}"],
			tools: [],
			denyTools: ["write_file", "edit_file", "create_directory", "move_file"],
		},
	};
	const template = templates[server];
	if (!template) throw new Error(`Unknown registry template: ${server}`);
	return {
		server,
		template,
		note: "Review transport, command path, env vars, and tool allowlist before adding this to .minimum/config.json.",
	};
}

function parseCsv(value: string | undefined): string[] {
	return value?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
}

function isToolError(value: unknown): boolean {
	return !!value && typeof value === "object" && (value as { isError?: boolean }).isError === true;
}

function extractToolText(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const content = (value as { content?: Array<{ text?: string }> }).content;
	return content?.[0]?.text;
}

if (process.argv[1]?.endsWith("MinimumMcpServer.js")) {
	startMinimumMcpServer();
}
