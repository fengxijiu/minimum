import type { ChatMessage, ToolCall } from "../types/common.js";

/**
 * Build a properly structured assistant message.
 *
 * Handles:
 * - tool_calls array (only when non-empty)
 * - reasoning_content (preserved for thinking-mode models)
 */
export function buildAssistantMessage(
	content: string,
	toolCalls: ToolCall[],
	reasoningContent?: string | null,
): ChatMessage {
	const msg: ChatMessage = { role: "assistant", content };
	if (toolCalls.length > 0) msg.tool_calls = toolCalls;
	if (reasoningContent) msg.reasoning_content = reasoningContent;
	return msg;
}

/** Build a synthetic assistant message (abort notices, forced summaries). */
export function buildSyntheticAssistantMessage(content: string): ChatMessage {
	return { role: "assistant", content };
}
