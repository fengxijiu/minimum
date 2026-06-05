import { loadLearnedSkills } from "../skills/LearnedSkillLoader.js";
import { listPersonas } from "../personas/index.js";
import { PlanCommandService } from "../plans/PlanCommandService.js";
import { readRecentAuditEvents } from "./McpAuditLogger.js";
import type { PlanDraft } from "../plans/types.js";
import { McpManager } from "./McpManager.js";
import type {
	McpFailedServerDetails,
	McpListedPrompt,
	McpListedResource,
	McpPrompt,
	McpServerDetails,
} from "./types.js";

export interface McpCommandServiceOptions {
	projectRoot: string;
	manager?: McpManager;
	failedServers?: McpFailedServerDetails[];
}

export interface McpOverview {
	connected: McpServerDetails[];
	failed: McpFailedServerDetails[];
	totalTools: number;
	totalResources: number;
	totalPrompts: number;
}

export interface McpPromptResult {
	name: string;
	server: string;
	content: unknown;
}

export class McpCommandService {
	private readonly planService: PlanCommandService;
	private resourceCache: { at: number; resources: McpListedResource[] } | null = null;
	private readonly cacheTtlMs = 2_000;

	constructor(private readonly options: McpCommandServiceOptions) {
		this.planService = new PlanCommandService({ projectRoot: options.projectRoot });
	}

	async getOverview(): Promise<McpOverview> {
		const connected = this.options.manager?.getServerDetails() ?? [];
		const localResources = await this.listBuiltinResources();
		const remoteResources = this.options.manager?.getAllResources() ?? [];
		const remotePrompts = this.options.manager?.getAllPrompts() ?? [];

		return {
			connected,
			failed: [...(this.options.failedServers ?? [])],
			totalTools: connected.reduce((sum, server) => sum + server.toolCount, 0),
			totalResources: localResources.length + remoteResources.length,
			totalPrompts: BUILTIN_PROMPTS.length + remotePrompts.length,
		};
	}

	async listResources(): Promise<McpListedResource[]> {
		if (this.resourceCache && Date.now() - this.resourceCache.at < this.cacheTtlMs) {
			return this.resourceCache.resources;
		}
		const local = await this.listBuiltinResources();
		const remote = this.options.manager?.getAllResources() ?? [];
		const resources = [...local, ...remote];
		this.resourceCache = { at: Date.now(), resources };
		return resources;
	}

	async readResource(ref: string): Promise<unknown> {
		if (ref.startsWith("minimum://")) {
			return this.readBuiltinResource(ref);
		}
		if (!this.options.manager) throw new Error("no MCP servers connected");
		return this.options.manager.readResource(ref);
	}

	listPrompts(): McpListedPrompt[] {
		const local = BUILTIN_PROMPTS.map((prompt) => ({ ...prompt, server: "minimum" }));
		const remote = this.options.manager?.getAllPrompts() ?? [];
		return [...local, ...remote];
	}

	async getPrompt(name: string, args?: Record<string, unknown>): Promise<McpPromptResult> {
		if (name.startsWith("minimum.") || name === "minimum::write_task_plan_draft") {
			return {
				name: "minimum.write_task_plan_draft",
				server: "minimum",
				content: renderBuiltinPrompt(args),
			};
		}
		if (!this.options.manager) throw new Error("no MCP servers connected");
		return {
			name,
			server: inferPromptServer(name),
			content: await this.options.manager.getPrompt(name, args),
		};
	}

	private async listBuiltinResources(): Promise<McpListedResource[]> {
		const drafts = await this.planService.status();
		const skills = await loadLearnedSkills(this.options.projectRoot);
		const personas = listPersonas();
		return [
			{
				server: "minimum",
				uri: "minimum://project_state",
				name: "project_state",
				description: "High-level project state for the current workspace",
				mimeType: "application/json",
			},
			{
				server: "minimum",
				uri: "minimum://skills",
				name: "skills",
				description: `Learned skills available in this workspace (${skills.length})`,
				mimeType: "application/json",
			},
			{
				server: "minimum",
				uri: "minimum://personas",
				name: "personas",
				description: `Registered personas available to Minimum (${personas.length})`,
				mimeType: "application/json",
			},
			{
				server: "minimum",
				uri: "minimum://task_plan_drafts",
				name: "task_plan_drafts",
				description: `Task plan drafts written under .minimum/plans/drafts (${drafts.drafts.length})`,
				mimeType: "application/json",
			},
			{
				server: "minimum",
				uri: "minimum://mcp_registry",
				name: "mcp_registry",
				description: "Trusted MCP registry and server discovery references",
				mimeType: "application/json",
			},
			{
				server: "minimum",
				uri: "minimum://mcp_health",
				name: "mcp_health",
				description: "MCP connectivity, capability, and hardening summary",
				mimeType: "application/json",
			},
			{
				server: "minimum",
				uri: "minimum://mcp_audit",
				name: "mcp_audit",
				description: "Recent MCP audit log entries with secrets redacted",
				mimeType: "application/json",
			},
		];
	}

	private async readBuiltinResource(uri: string): Promise<unknown> {
		switch (uri) {
			case "minimum://project_state":
				return this.buildProjectState();
			case "minimum://skills":
				return this.buildSkillsState();
			case "minimum://personas":
				return this.buildPersonasState();
			case "minimum://task_plan_drafts":
				return this.buildPlanDraftState();
			case "minimum://mcp_registry":
				return this.buildRegistryState();
			case "minimum://mcp_health":
				return this.buildHealthState();
			case "minimum://mcp_audit":
				return this.buildAuditState();
			default:
				throw new Error(`unknown built-in MCP resource: ${uri}`);
		}
	}

	private async buildProjectState(): Promise<Record<string, unknown>> {
		const [skills, drafts, overview] = await Promise.all([
			loadLearnedSkills(this.options.projectRoot),
			this.planService.status(),
			this.getOverview(),
		]);
		return {
			projectRoot: this.options.projectRoot,
			generatedAt: new Date().toISOString(),
			learnedSkillCount: skills.length,
			planDraftCount: drafts.drafts.length,
			personaCount: listPersonas().length,
			mcp: overview,
		};
	}

	private async buildSkillsState(): Promise<Record<string, unknown>> {
		const skills = await loadLearnedSkills(this.options.projectRoot);
		return {
			projectRoot: this.options.projectRoot,
			count: skills.length,
			skills: skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
				tags: skill.tags,
				path: skill.path,
				status: skill.status,
			})),
		};
	}

	private async buildPersonasState(): Promise<Record<string, unknown>> {
		const personas = listPersonas();
		return {
			count: personas.length,
			personas: personas.map((persona) => ({
				id: persona.id,
				kind: persona.kind,
				model: persona.model,
				maxSteps: persona.maxSteps,
				maxTokens: persona.maxTokens,
				toolAllowlist: persona.toolAllowlist,
				toolDenylist: persona.toolDenylist,
			})),
		};
	}

	private async buildPlanDraftState(): Promise<Record<string, unknown>> {
		const drafts = await this.planService.status();
		return {
			count: drafts.drafts.length,
			drafts: drafts.drafts.map(summarizeDraft),
		};
	}

	private buildRegistryState(): Record<string, unknown> {
		return {
			sources: [
				{ name: "official-registry", url: "https://github.com/modelcontextprotocol/registry", trusted: true },
				{ name: "official-servers", url: "https://github.com/modelcontextprotocol/servers", trusted: true },
				{ name: "github-mcp-server", url: "https://github.com/github/github-mcp-server", trusted: true },
			],
			configChecklist: [
				"Choose transport explicitly.",
				"Set headers through environment variables.",
				"Use tools allowlist and denyTools for exposed capabilities.",
				"Keep write-capable tools disabled unless approval policy allows them.",
			],
		};
	}

	private async buildHealthState(): Promise<Record<string, unknown>> {
		const overview = await this.getOverview();
		return {
			projectRoot: this.options.projectRoot,
			generatedAt: new Date().toISOString(),
			status: overview.failed.length ? "degraded" : "ok",
			overview,
			paths: {
				audit: ".minimum/mcp/audit.log",
				planDrafts: ".minimum/plans/drafts",
				examples: "examples/mcp",
			},
			recommendations: [
				"Prefer stdio for local trusted servers and streamable HTTP for remote servers.",
				"Use env placeholders for secrets; never store token values in .minimum/config.json.",
				"Constrain exposed tools with tools and denyTools, especially for write-capable servers.",
				"Check /mcp audit after exercising new servers.",
			],
		};
	}

	private async buildAuditState(): Promise<Record<string, unknown>> {
		const events = await readRecentAuditEvents(this.options.projectRoot, 100);
		return {
			count: events.length,
			path: ".minimum/mcp/audit.log",
			events,
		};
	}
}

const BUILTIN_PROMPTS: McpPrompt[] = [
	{
		name: "minimum.write_task_plan_draft",
		description: "Generate a JSON task-plan draft that Minimum TUI can preview and import.",
		arguments: [
			{ name: "task", description: "The user request or task objective.", required: true },
			{ name: "title", description: "Short plan title.", required: true },
			{ name: "notes", description: "Optional extra constraints or context.", required: false },
		],
	},
];

function summarizeDraft(draft: PlanDraft): Record<string, unknown> {
	return {
		id: draft.id,
		title: draft.title,
		status: draft.status,
		stepCount: draft.steps.length,
		createdAt: draft.createdAt,
		updatedAt: draft.updatedAt,
		source: draft.source,
	};
}

function renderBuiltinPrompt(args?: Record<string, unknown>): Record<string, unknown> {
	const task = typeof args?.task === "string" ? args.task.trim() : "";
	const title = typeof args?.title === "string" ? args.title.trim() : "";
	const notes = typeof args?.notes === "string" ? args.notes.trim() : "";
	return {
		description: BUILTIN_PROMPTS[0]!.description,
		messages: [
			{
				role: "user",
				content: [
					"Generate a Minimum-compatible plan draft JSON object.",
					'Use shape: {"title": string, "steps": [{"label": string, "status": "next"|"now"|"done"}], "source": "mcp"}.',
					"Keep exactly one step at status \"now\" only when active work is already known; otherwise mark all steps as \"next\".",
					task ? `Task: ${task}` : null,
					title ? `Title: ${title}` : null,
					notes ? `Notes: ${notes}` : null,
				].filter(Boolean).join("\n"),
			},
		],
	};
}

function inferPromptServer(name: string): string {
	const index = name.indexOf("::");
	if (index > 0) return name.slice(0, index);
	return "remote";
}
