export type PlanDraftStepStatus = "done" | "now" | "next";

export interface PlanDraftStep {
	label: string;
	status: PlanDraftStepStatus;
}

export type PlanDraftStatus = "draft" | "imported" | "rejected" | "invalid";

export interface PlanDraft {
	id: string;
	title: string;
	steps: PlanDraftStep[];
	status: PlanDraftStatus;
	createdAt: string;
	updatedAt: string;
	source?: string;
	errors?: string[];
}

export interface PlanPreviewResult {
	draft: PlanDraft;
	markdown: string;
}

export interface PlanImportResult {
	draft: PlanDraft;
	title: string;
	steps: PlanDraftStep[];
}

export interface PlanStatusResult {
	drafts: PlanDraft[];
}
