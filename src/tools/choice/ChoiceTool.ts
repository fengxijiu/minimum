import type {
	ChoiceOption,
	ConfirmationGate,
} from "./ConfirmationGate.js";
import { CancelledConfirmationGate } from "./ConfirmationGate.js";

function sanitizeOptions(raw: unknown): ChoiceOption[] {
	if (!Array.isArray(raw)) return [];
	const out: ChoiceOption[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const id = typeof e["id"] === "string" ? e["id"].trim() : "";
		const title = typeof e["title"] === "string" ? e["title"].trim() : "";
		if (!id || !title) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		const summary = typeof e["summary"] === "string" ? e["summary"].trim() || undefined : undefined;
		const opt: ChoiceOption = { id, title };
		if (summary) opt.summary = summary;
		out.push(opt);
	}
	return out;
}

/**
 * ChoiceTool — 让模型在 2–6 个备选间停下问用户。
 * 底层依赖 ConfirmationGate 阻塞返回。无 TUI 接线时使用 CancelledConfirmationGate。
 */
export class ChoiceTool {
	name = "ask_choice";
	description =
		"Render a picker with 2–6 alternatives. Use when the user is supposed to pick — never enumerate choices as prose. Skip when one option is clearly best (just do it) or a free-form text answer fits. Max 6 options; set `allowCustom:true` when their real answer might not fit.";

	private readonly gate: ConfirmationGate;

	constructor(options: { gate?: ConfirmationGate } = {}) {
		this.gate = options.gate ?? new CancelledConfirmationGate();
	}

	getDefinition() {
		return {
			name: this.name,
			description: this.description,
			parameters: {
				type: "object",
				properties: {
					question: {
						type: "string",
						description: "One-sentence question. Don't repeat the options here.",
					},
					options: {
						type: "array",
						description: "2–6 alternatives. Each: stable id + short title; summary optional.",
						items: {
							type: "object",
							properties: {
								id: { type: "string", description: "Stable id (A, B, C or option-1)." },
								title: { type: "string", description: "One-line label." },
								summary: {
									type: "string",
									description: "Optional dimmed second line, ≤80 chars.",
								},
							},
							required: ["id", "title"],
						},
					},
					allowCustom: {
						type: "boolean",
						description: "Shows a 'type my own answer' escape hatch. Default false.",
					},
				},
				required: ["question", "options"],
			},
		};
	}

	async execute(args: Record<string, unknown>): Promise<string> {
		const question = typeof args?.["question"] === "string" ? (args["question"] as string).trim() : "";
		if (!question) {
			return "Error: ask_choice: question is required — write one sentence explaining the decision.";
		}
		const options = sanitizeOptions(args?.["options"]);
		if (options.length < 2) {
			return "Error: ask_choice: need at least 2 well-formed options (each with a non-empty id and title).";
		}
		if (options.length > 6) {
			return "Error: ask_choice: too many options (max 6). Split into two sequential ask_choice calls or narrow down first.";
		}
		const allowCustom = args?.["allowCustom"] === true;
		const verdict = await this.gate.ask({ question, options, allowCustom });
		if (verdict.type === "pick") return `user picked: ${verdict.optionId}`;
		if (verdict.type === "text") return `user answered: ${verdict.text}`;
		return "user cancelled the choice";
	}
}
