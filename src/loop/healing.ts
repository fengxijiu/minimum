import type { ChatMessage, ToolCall } from "../types/common.js";

let _stampSeq = 0;

/** DeepSeek/MiMo 400s on tool_calls missing `id`. Give bare calls a fallback. */
function stampMissingIds(calls: ToolCall[]): ToolCall[] {
	return calls.map((c) =>
		c.id ? c : { ...c, id: `ext-${Date.now()}-${_stampSeq++}` },
	);
}

/**
 * Drop unpaired assistant.tool_calls and stray tool messages.
 *
 * An assistant message with tool_calls MUST be followed by exactly one
 * tool result per call_id. If any are missing, the whole set is dropped
 * to prevent API 400 errors.
 */
export function fixToolCallPairing(messages: ChatMessage[]): {
	messages: ChatMessage[];
	droppedAssistantCalls: number;
	droppedStrayTools: number;
} {
	const out: ChatMessage[] = [];
	let droppedAssistantCalls = 0;
	let droppedStrayTools = 0;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]!;
		if (
			msg.role === "assistant" &&
			Array.isArray(msg.tool_calls) &&
			msg.tool_calls.length > 0
		) {
			const calls = stampMissingIds(msg.tool_calls);
			const needed = new Set<string>();
			for (const call of calls) {
				if (call.id) needed.add(call.id);
			}
			const candidates: ChatMessage[] = [];
			let j = i + 1;
			while (j < messages.length && needed.size > 0) {
				const nxt = messages[j]!;
				if (nxt.role !== "tool") break;
				const id = nxt.tool_call_id ?? "";
				if (!needed.has(id)) break;
				needed.delete(id);
				candidates.push(nxt);
				j++;
			}
			if (needed.size === 0) {
				out.push({ ...msg, tool_calls: calls });
				for (const r of candidates) out.push(r);
				i = j - 1;
			} else {
				droppedAssistantCalls += 1;
				droppedStrayTools += candidates.length;
				i = j - 1;
			}
			continue;
		}
		if (msg.role === "tool") {
			droppedStrayTools += 1;
			continue;
		}
		out.push(msg);
	}

	return { messages: out, droppedAssistantCalls, droppedStrayTools };
}

/**
 * Truncate oversized tool results to prevent context overflow.
 */
export function shrinkOversizedToolResults(
	messages: ChatMessage[],
	maxChars: number,
): { messages: ChatMessage[]; healedCount: number } {
	let healedCount = 0;
	const out = messages.map((msg) => {
		if (msg.role !== "tool") return msg;
		if (typeof msg.content !== "string") return msg;
		if (msg.content.length <= maxChars) return msg;
		healedCount++;
		return {
			...msg,
			content:
				msg.content.slice(0, maxChars) +
				`\n\n[truncated: ${msg.content.length} → ${maxChars} chars]`,
		};
	});
	return { messages: out, healedCount };
}

/**
 * Full heal pipeline: shrink oversized results, fix pairing.
 */
export function healMessages(
	messages: ChatMessage[],
	maxChars: number,
): { messages: ChatMessage[]; healedCount: number } {
	const shrunk = shrinkOversizedToolResults(messages, maxChars);
	const paired = fixToolCallPairing(shrunk.messages);
	return {
		messages: paired.messages,
		healedCount:
			shrunk.healedCount +
			paired.droppedAssistantCalls +
			paired.droppedStrayTools,
	};
}
