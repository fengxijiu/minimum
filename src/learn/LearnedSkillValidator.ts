import type { LearnedSkillDraftInput } from "./types.js";
import { isValidSkillSlug, toSkillSlug } from "./LearnedSkillName.js";

export interface LearnedSkillValidationResult {
	ok: boolean;
	errors: string[];
}

const REQUIRED_SECTIONS = [
	"Purpose",
	"When to Use",
	"Inputs",
	"Core Workflow",
	"Output Contract",
	"Rules and Constraints",
	"Verification Checklist",
	"Failure Modes",
];

const SENSITIVE_PATTERNS = [
	/api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9_.-]{12,}/i,
	/token\s*[:=]\s*['"]?[A-Za-z0-9_.-]{12,}/i,
	/password\s*[:=]\s*['"]?\S{6,}/i,
	/(sk|tp)-[A-Za-z0-9]{16,}/,
];

export function validateLearnedSkillDraft(
	draft: LearnedSkillDraftInput,
): LearnedSkillValidationResult {
	const errors: string[] = [];
	const slug = toSkillSlug(draft.name);

	if (!draft.name.trim()) errors.push("name is required");
	else if (!isValidSkillSlug(slug)) errors.push("name must be a valid slug");

	if (!draft.description.trim()) errors.push("description is required");
	else if (!draft.description.trim().startsWith("Use when")) {
		errors.push("description must start with Use when");
	}

	if (!draft.body.trim()) errors.push("body is required");
	for (const section of REQUIRED_SECTIONS) {
		const re = new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, "im");
		if (!re.test(draft.body)) errors.push(`body must include ## ${section}`);
	}

	const combined = `${draft.description}\n${draft.body}`;
	for (const pattern of SENSITIVE_PATTERNS) {
		if (pattern.test(combined)) {
			errors.push("draft appears to contain sensitive credentials");
			break;
		}
	}

	if (/can_modify_persona:\s*true/i.test(draft.body)) {
		errors.push("learned skills cannot modify personas");
	}
	if (/\.minimum\/memory/i.test(draft.body)) {
		errors.push("learned skills cannot write .minimum/memory");
	}

	return { ok: errors.length === 0, errors };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
