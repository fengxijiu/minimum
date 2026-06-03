import type {
	ChoiceOption,
	ConfirmationGate,
} from "./ConfirmationGate.js";
import { CancelledConfirmationGate } from "./ConfirmationGate.js";

const MAX_QUESTION_CHARS = 100;
const MAX_TITLE_CHARS = 50;
const MAX_SUMMARY_CHARS = 80;

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
						description: `Decision point only. ≤${MAX_QUESTION_CHARS} chars. No context or tradeoff explanation. Example: "Which upload strategy?" not "Given that we need to choose between X and Y…"`,
					},
					options: {
						type: "array",
						description: "2–6 alternatives. Each: stable id + short title (≤50 chars); summary optional (≤80 chars, one phrase).",
						items: {
							type: "object",
							properties: {
								id: { type: "string", description: "Stable id (A, B, C or option-1)." },
								title: { type: "string", description: `2–5 words naming the option. ≤${MAX_TITLE_CHARS} chars.` },
								summary: {
									type: "string",
									description: `One trade-off phrase. ≤${MAX_SUMMARY_CHARS} chars. No full sentences.`,
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
			return "Error: ask_choice: question is required — write one sentence naming the decision point.";
		}
		if (question.length > MAX_QUESTION_CHARS) {
			return `Error: ask_choice: question is ${question.length} chars (max ${MAX_QUESTION_CHARS}). Rewrite: state the decision point only, no context or tradeoff explanation. Pattern: "Which <noun>?" or "<Verb> — which way?"`;
		}
		const options = sanitizeOptions(args?.["options"]);
		if (options.length < 2) {
			return "Error: ask_choice: need at least 2 well-formed options (each with a non-empty id and title).";
		}
		if (options.length > 6) {
			return "Error: ask_choice: too many options (max 6). Split into two sequential ask_choice calls or narrow down first.";
		}
		const longTitle = options.find((o) => o.title.length > MAX_TITLE_CHARS);
		if (longTitle) {
			return `Error: ask_choice: option "${longTitle.id}" title is ${longTitle.title.length} chars (max ${MAX_TITLE_CHARS}). Use 2–5 words naming the option, no sentence.`;
		}
		// Silently truncate summaries — they are UX hints, not decision content.
		for (const opt of options) {
			if (opt.summary && opt.summary.length > MAX_SUMMARY_CHARS) {
				opt.summary = opt.summary.slice(0, MAX_SUMMARY_CHARS - 1) + "…";
			}
		}
		const allowCustom = args?.["allowCustom"] === true;
		const verdict = await this.gate.ask({ question, options, allowCustom });
		if (verdict.type === "pick") return `user picked: ${verdict.optionId}`;
		if (verdict.type === "text") return `user answered: ${verdict.text}`;
		return "user cancelled the choice";
	}
}
