import * as path from "node:path";
import { assignSkillToPersona, buildRoutingMetadata, writePersonaSkillRouting } from "../skills/PersonaSkillRouter.js";
import { loadLearnedSkills } from "../skills/LearnedSkillLoader.js";
import { LearnDraftStore } from "./LearnDraftStore.js";
import { LearnSkillPromptLoader } from "./LearnSkillPromptLoader.js";
import { toSkillSlug, titleFromSlug } from "./LearnedSkillName.js";
import { renderLearnedSkillMarkdown } from "./LearnedSkillRenderer.js";
import { validateLearnedSkillDraft } from "./LearnedSkillValidator.js";
import { LearnedSkillWriter } from "./LearnedSkillWriter.js";
import type {
	LearnApplyResult,
	LearnCreateRequest,
	LearnCreateResult,
	LearnedSkillDraft,
	LearnedSkillDraftInput,
	LearnPreviewResult,
	LearnStatusResult,
} from "./types.js";

export interface LearnCommandServiceOptions {
	projectRoot: string;
	generateWithModel?: (prompt: string) => Promise<string>;
	reloadSkills?: () => Promise<void>;
}

export class LearnCommandService {
	private readonly draftStore: LearnDraftStore;
	private readonly promptLoader = new LearnSkillPromptLoader();
	private readonly writer: LearnedSkillWriter;

	constructor(private readonly options: LearnCommandServiceOptions) {
		this.draftStore = new LearnDraftStore(options.projectRoot);
		this.writer = new LearnedSkillWriter(options.projectRoot);
	}

	async create(request: LearnCreateRequest): Promise<LearnCreateResult> {
		const existingSkillNames = (await loadLearnedSkills(this.options.projectRoot)).map((s) => s.name);
		const prompt = await this.promptLoader.buildPrompt({
			conversationSummary: summarizeMessages(request.messages),
			recentMessages: request.messages.slice(-20),
			preferredName: request.preferredName,
			projectRoot: this.options.projectRoot,
			existingSkillNames,
		});
		const generated = this.options.generateWithModel
			? await this.options.generateWithModel(prompt)
			: JSON.stringify(fallbackDraft(request));
		const input = parseDraft(generated, request);
		const validation = validateLearnedSkillDraft(input);
		const now = new Date().toISOString();
		const slug = toSkillSlug(input.name);
		const id = `learn_${now.replace(/[-:.TZ]/g, "").slice(0, 14)}_${slug}`;
		const targetDir = path.join(this.options.projectRoot, ".minimum", "skills", "learned", slug);
		const draft: LearnedSkillDraft = {
			...input,
			name: slug,
			id,
			status: validation.ok ? "draft" : "invalid",
			createdAt: now,
			updatedAt: now,
			preferredName: request.preferredName,
			source: "learn",
			targetDir,
			targetPath: path.join(targetDir, "SKILL.md"),
			...(validation.ok ? {} : { errors: validation.errors }),
		};

		if (!request.dryRun) await this.draftStore.save(draft);
		return { draft, validation, dryRun: request.dryRun ?? false };
	}

	async preview(draftId: string): Promise<LearnPreviewResult> {
		const draft = await this.draftStore.read(draftId);
		return { draft, markdown: renderLearnedSkillMarkdown(draft) };
	}

	async apply(draftId: string): Promise<LearnApplyResult> {
		const draft = await this.draftStore.read(draftId);
		const validation = validateLearnedSkillDraft(draft);
		if (!validation.ok) throw new Error(`invalid learned skill draft: ${validation.errors.join("; ")}`);
		const written = await this.writer.write(draft);
		const assignments = assignSkillToPersona({
			skillName: draft.name,
			description: draft.description,
			body: draft.body,
			source: "learn",
		});
		const routing = buildRoutingMetadata(draft, assignments);
		await writePersonaSkillRouting({
			projectRoot: this.options.projectRoot,
			metadata: routing,
			assignments,
		});
		const appliedDraft: LearnedSkillDraft = {
			...draft,
			status: "applied",
			updatedAt: new Date().toISOString(),
			targetPath: written.skillPath,
		};
		await this.draftStore.save(appliedDraft);
		await this.options.reloadSkills?.();

		return {
			draft: appliedDraft,
			skillPath: written.skillPath,
			metadataPath: written.metadataPath,
			assignments,
			routing,
		};
	}

	async reject(draftId: string): Promise<LearnedSkillDraft> {
		const draft = await this.draftStore.read(draftId);
		const rejected = { ...draft, status: "rejected" as const, updatedAt: new Date().toISOString() };
		await this.draftStore.save(rejected);
		return rejected;
	}

	async status(): Promise<LearnStatusResult> {
		const drafts = await this.draftStore.list();
		const learnedSkills = (await loadLearnedSkills(this.options.projectRoot)).map((skill) => ({
			name: skill.name,
			path: skill.path,
			status: skill.status,
		}));
		return { drafts, learnedSkills };
	}
}

function parseDraft(raw: string, request: LearnCreateRequest): LearnedSkillDraftInput {
	const json = extractJson(raw);
	const parsed = JSON.parse(json) as Partial<LearnedSkillDraftInput>;
	const name = toSkillSlug(parsed.name ?? request.preferredName ?? "learned-skill");
	return {
		name,
		description: parsed.description ?? `Use when applying ${name} project learning.`,
		body: parsed.body ?? fallbackBody(name),
		tags: parsed.tags ?? [],
		triggers: parsed.triggers ?? [],
		capability_tags: parsed.capability_tags ?? parsed.tags ?? [],
	};
}

function extractJson(raw: string): string {
	const trimmed = raw.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) return fenced[1].trim();
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
	return trimmed;
}

function fallbackDraft(request: LearnCreateRequest): LearnedSkillDraftInput {
	const slug = toSkillSlug(request.preferredName ?? "session-learning");
	return {
		name: slug,
		description: `Use when applying the ${slug} workflow learned from this project session.`,
		body: fallbackBody(slug),
		tags: ["context-learning"],
		triggers: [slug],
		capability_tags: ["context_learning"],
	};
}

function fallbackBody(slug: string): string {
	const title = titleFromSlug(slug);
	return `# ${title}

## Purpose
Capture reusable project-local learning from the current session.

## When to Use
Use when the same project-local workflow or decision pattern appears again.

## Inputs
- Current task request.
- Relevant project context.

## Core Workflow
1. Identify the stable reusable rule.
2. Ignore one-off session details.
3. Apply the rule only when the trigger matches.

## Output Contract
Return concise guidance or a concrete next action for the current task.

## Rules and Constraints
- Do not modify personas.
- Do not write project memory directly.

## Verification Checklist
- The trigger matches the current task.
- The guidance is reusable and project-local.

## Failure Modes
- If the context is too noisy, ask for clarification or skip this skill.
`;
}

function summarizeMessages(messages: Array<{ role: string; content: string }>): string {
	return messages
		.filter((m) => m.content.trim())
		.slice(-12)
		.map((m) => `${m.role}: ${m.content.slice(0, 600)}`)
		.join("\n");
}
