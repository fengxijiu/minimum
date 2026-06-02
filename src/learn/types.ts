import type { PersonaSkillAssignment, SkillRoutingMetadata } from "../skills/PersonaSkillRouter.js";

export interface LearnMessage {
	role: string;
	content: string;
}

export interface LearnedSkillDraftInput {
	name: string;
	description: string;
	body: string;
	tags?: string[];
	triggers?: string[];
	capability_tags?: string[];
}

export interface LearnedSkillDraft extends LearnedSkillDraftInput {
	id: string;
	status: "draft" | "applied" | "rejected" | "invalid";
	createdAt: string;
	updatedAt: string;
	preferredName?: string;
	source: "learn";
	targetDir: string;
	targetPath: string;
	errors?: string[];
}

export interface LearnCreateRequest {
	preferredName?: string;
	dryRun?: boolean;
	messages: LearnMessage[];
}

export interface LearnCreateResult {
	draft: LearnedSkillDraft;
	validation: { ok: boolean; errors: string[] };
	dryRun: boolean;
}

export interface LearnPreviewResult {
	draft: LearnedSkillDraft;
	markdown: string;
}

export interface LearnApplyResult {
	draft: LearnedSkillDraft;
	skillPath: string;
	metadataPath: string;
	assignments: PersonaSkillAssignment[];
	routing: SkillRoutingMetadata;
	routingWritten: boolean;
	routingConfirmationRequired: boolean;
}

export interface LearnStatusResult {
	drafts: LearnedSkillDraft[];
	learnedSkills: Array<{ name: string; path: string; status: string }>;
}
