import { PlanDraftStore } from "./PlanDraftStore.js";
import type {
	PlanDraft,
	PlanDraftStatus,
	PlanDraftStep,
	PlanDraftStepStatus,
	PlanImportResult,
	PlanPreviewResult,
	PlanStatusResult,
} from "./types.js";

export interface PlanCommandServiceOptions {
	projectRoot: string;
}

export class PlanCommandService {
	private readonly draftStore: PlanDraftStore;

	constructor(private readonly options: PlanCommandServiceOptions) {
		this.draftStore = new PlanDraftStore(options.projectRoot);
	}

	async preview(draftId: string): Promise<PlanPreviewResult> {
		const draft = normalizePlanDraft(await this.draftStore.readRaw(draftId), draftId);
		return { draft, markdown: renderPlanDraftMarkdown(draft) };
	}

	async import(draftId: string): Promise<PlanImportResult> {
		const draft = normalizePlanDraft(await this.draftStore.readRaw(draftId), draftId);
		if (draft.status === "invalid") {
			throw new Error(`invalid plan draft: ${(draft.errors ?? ["unknown validation error"]).join("; ")}`);
		}
		const imported: PlanDraft = {
			...draft,
			status: "imported",
			updatedAt: new Date().toISOString(),
		};
		await this.draftStore.save(imported);
		return {
			draft: imported,
			title: imported.title,
			steps: imported.steps,
		};
	}

	async reject(draftId: string): Promise<PlanDraft> {
		const draft = normalizePlanDraft(await this.draftStore.readRaw(draftId), draftId);
		const rejected: PlanDraft = {
			...draft,
			status: "rejected",
			updatedAt: new Date().toISOString(),
		};
		await this.draftStore.save(rejected);
		return rejected;
	}

	async status(): Promise<PlanStatusResult> {
		const drafts = (await this.draftStore.listRaw())
			.map(({ id, raw }) => normalizePlanDraft(raw, id))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return { drafts };
	}
}

export function normalizePlanDraft(raw: unknown, fallbackId: string): PlanDraft {
	const now = new Date().toISOString();
	const base: PlanDraft = {
		id: fallbackId,
		title: "Imported plan draft",
		steps: [],
		status: "invalid",
		createdAt: now,
		updatedAt: now,
		source: "mcp",
		errors: ["draft must be an object"],
	};

	if (!raw || typeof raw !== "object") return base;
	const input = raw as Record<string, unknown>;
	const steps = normalizeSteps(input.steps ?? input.todos);
	const errors: string[] = [];
	if (steps.length === 0) errors.push("draft must contain at least one valid step");

	const normalized: PlanDraft = {
		id: typeof input.id === "string" && isSafeDraftId(input.id.trim()) ? input.id.trim() : fallbackId,
		title: typeof input.title === "string" && input.title.trim()
			? input.title.trim()
			: typeof input.name === "string" && input.name.trim()
				? input.name.trim()
				: "Imported plan draft",
		steps,
		status: normalizeDraftStatus(input.status, errors.length === 0),
		createdAt: typeof input.createdAt === "string" ? input.createdAt : now,
		updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now,
		source: typeof input.source === "string" && input.source.trim() ? input.source.trim() : "mcp",
		...(errors.length ? { errors } : {}),
	};

	return normalized;
}

export function renderPlanDraftMarkdown(draft: PlanDraft): string {
	const lines = [
		`# ${draft.title}`,
		"",
		`id: ${draft.id}`,
		`status: ${draft.status}`,
		`source: ${draft.source ?? "mcp"}`,
		"",
		"## Steps",
		...draft.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.label}`),
	];
	if (draft.errors?.length) {
		lines.push("", "## Errors", ...draft.errors.map((error) => `- ${error}`));
	}
	return lines.join("\n");
}

function normalizeSteps(raw: unknown): PlanDraftStep[] {
	if (!Array.isArray(raw)) return [];
	const out: PlanDraftStep[] = [];
	for (const entry of raw) {
		if (typeof entry === "string" && entry.trim()) {
			out.push({ label: entry.trim(), status: "next" });
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const obj = entry as Record<string, unknown>;
		const label = pickFirstString(obj.label, obj.content, obj.activeForm, obj.name);
		if (!label) continue;
		out.push({
			label,
			status: normalizeStepStatus(obj.status),
		});
	}
	return out;
}

function pickFirstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function normalizeStepStatus(raw: unknown): PlanDraftStepStatus {
	if (typeof raw !== "string") return "next";
	const value = raw.trim().toLowerCase();
	if (value === "done" || value === "completed" || value === "complete") return "done";
	if (value === "now" || value === "in_progress" || value === "in-progress" || value === "active" || value === "current") {
		return "now";
	}
	return "next";
}

function normalizeDraftStatus(raw: unknown, valid: boolean): PlanDraftStatus {
	if (!valid) return "invalid";
	if (raw === "imported" || raw === "rejected" || raw === "draft") return raw;
	return "draft";
}

function isSafeDraftId(value: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}
