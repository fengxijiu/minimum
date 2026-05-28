import type { LoopEvent } from "../loop/MiMoLoop.js";

/**
 * UiEvent — 前端无关的规范化事件流。
 *
 * MiMoLoop 的 LoopEvent 偏引擎内部；UiEvent 是给任意前端（Ink TUI / web /
 * headless）消费的稳定契约。EngineBridge 负责两者的翻译，这样 TUI 不必关心
 * 引擎内部事件的演进。参考 OpenCode 的「单一事件流，多前端共用」。
 */
export type UiEvent =
	| { kind: "assistant"; text: string }
	| { kind: "reasoning"; text: string }
	| { kind: "tool"; name: string; args: string }
	| { kind: "tool_result"; name: string; ok: boolean; content: string }
	| { kind: "notice"; text: string; tone: "info" | "warn" | "ok" }
	| { kind: "error"; text: string }
	| { kind: "done"; success: boolean }
	| { kind: "streaming"; text: string }
	| { kind: "streaming_reasoning"; text: string }
	| { kind: "streaming_start" }
	| { kind: "streaming_end" };

export interface EngineLoop {
	run(userInput: string): AsyncGenerator<LoopEvent>;
}

/** Translate a single engine event into zero or one UI events. */
export function mapLoopEvent(e: LoopEvent): UiEvent | null {
	switch (e.type) {
		case "content":
			return { kind: "assistant", text: e.content };
		case "reasoning":
			return { kind: "reasoning", text: e.content };
		case "tool_call":
			return {
				kind: "tool",
				name: e.toolCall.function.name,
				args: e.toolCall.function.arguments || "",
			};
		case "tool_result":
			return {
				kind: "tool_result",
				name: e.toolCall.function.name,
				ok: e.success,
				content: typeof e.result?.content === "string" ? e.result.content : "",
			};
		case "validation":
			return e.result?.passed
				? null
				: { kind: "notice", text: "validation failed", tone: "warn" };
		case "completeness":
			return e.result?.complete
				? null
				: { kind: "notice", text: "incomplete — agent will continue", tone: "warn" };
		case "context_optimized":
			return e.result?.folded
				? { kind: "notice", text: "context folded", tone: "info" }
				: null;
		case "capacity":
			return e.snapshot.action === "no_intervention"
				? null
				: { kind: "notice", text: `capacity: ${e.snapshot.action}`, tone: "warn" };
		case "hook":
			return { kind: "notice", text: `hook · ${e.event}`, tone: "info" };
		case "plan_blocked":
			return {
				kind: "notice",
				text: `plan mode blocked ${e.toolCall.function.name}`,
				tone: "warn",
			};
		case "iteration":
			return { kind: "notice", text: `retry ${e.attempt}/${e.maxAttempts}`, tone: "info" };
		case "steer_accepted":
			return { kind: "notice", text: `steer: ${e.content}`, tone: "info" };
		case "usage":
			return null;
		case "error":
			return { kind: "error", text: e.error };
		case "done":
			return { kind: "done", success: e.success };
		default:
			return null;
	}
}

/**
 * EngineBridge — 把一个 MiMoLoop（或兼容对象）包成规范化事件流。
 */
export class EngineBridge {
	private streamingBuffer = "";
	private streamingReasonBuffer = "";

	constructor(private loop: EngineLoop) {
		// Wire onChunk to emit streaming events if the loop supports it.
		if ("config" in loop && typeof loop.config === "object" && loop.config) {
			(loop.config as any).onChunk = (chunk: {
				type: "content" | "reasoning" | "tool_call";
				text?: string;
				name?: string;
			}) => {
				if (chunk.type === "content" && chunk.text) {
					this.streamingBuffer += chunk.text;
				} else if (chunk.type === "reasoning" && chunk.text) {
					this.streamingReasonBuffer += chunk.text;
				}
			};
		}
	}

	async *send(userInput: string): AsyncGenerator<UiEvent> {
		this.streamingBuffer = "";
		this.streamingReasonBuffer = "";

		for await (const e of this.loop.run(userInput)) {
			// Before yielding the final content event, emit any buffered streaming text.
			if (e.type === "content" && this.streamingBuffer) {
				yield { kind: "streaming", text: this.streamingBuffer };
				this.streamingBuffer = "";
			}
			if (e.type === "reasoning" && this.streamingReasonBuffer) {
				yield { kind: "streaming_reasoning", text: this.streamingReasonBuffer };
				this.streamingReasonBuffer = "";
			}

			const ui = mapLoopEvent(e);
			if (ui) yield ui;
		}
	}
}
