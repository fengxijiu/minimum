import type { LoopEvent } from "../../loop/MiMoLoop.js";

export type TuiEvent =
	| { type: "turn.started"; turnId: number; input: string }
	| { type: "assistant.delta"; turnId: number; content: string }
	| { type: "assistant.reasoning"; turnId: number; content: string }
	| {
			type: "tool.started";
			turnId: number;
			name: string;
			args: Record<string, unknown>;
			repaired: boolean;
	  }
	| {
			type: "tool.completed";
			turnId: number;
			name: string;
			result: string;
			success: boolean;
	  }
	| { type: "validation.warning"; turnId: number; message: string }
	| { type: "context.optimized"; turnId: number; message: string }
	| { type: "usage"; turnId: number; usage: Record<string, unknown> }
	| { type: "turn.completed"; turnId: number; success: boolean; result?: string }
	| { type: "turn.cancelled"; turnId: number }
	| { type: "turn.error"; turnId: number; error: string; recoverable: boolean }
	| { type: "steer.accepted"; turnId: number; content: string };

export function loopEventToTuiEvent(
	turnId: number,
	event: LoopEvent,
): TuiEvent | null {
	switch (event.type) {
		case "content":
			return { type: "assistant.delta", turnId, content: event.content };
		case "reasoning":
			return { type: "assistant.reasoning", turnId, content: event.content };
		case "tool_call":
			return {
				type: "tool.started",
				turnId,
				name: event.toolCall.function.name,
				args: parseArgs(event.toolCall.function.arguments),
				repaired: event.repaired,
			};
		case "tool_result":
			return {
				type: "tool.completed",
				turnId,
				name: event.toolCall.function.name,
				result: stringifyResult(event.result),
				success: event.success,
			};
		case "validation":
			if (event.result?.passed) return null;
			return {
				type: "validation.warning",
				turnId,
				message: Array.isArray(event.result?.suggestions)
					? event.result.suggestions.join(", ")
					: "Validation failed",
			};
		case "context_optimized":
			return {
				type: "context.optimized",
				turnId,
				message: event.result?.folded ? "Context compacted for this turn" : "Context checked",
			};
		case "usage":
			return { type: "usage", turnId, usage: event.usage ?? {} };
		case "done":
			return {
				type: "turn.completed",
				turnId,
				success: event.success,
				result: event.result,
			};
		case "error":
			return {
				type: "turn.error",
				turnId,
				error: event.error,
				recoverable: event.recoverable,
			};
		case "steer_accepted":
			return { type: "steer.accepted", turnId, content: event.content };
		case "completeness":
		case "iteration":
			return null;
		default:
			return null;
	}
}

function parseArgs(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: { value: parsed };
	} catch {
		return { raw };
	}
}

function stringifyResult(result: unknown): string {
	if (typeof result === "string") return result;
	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		typeof (result as { content?: unknown }).content === "string"
	) {
		return (result as { content: string }).content;
	}
	try {
		return JSON.stringify(result);
	} catch {
		return String(result);
	}
}
