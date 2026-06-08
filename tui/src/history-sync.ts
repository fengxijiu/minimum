import type { ChatHistoryMessage, Runner } from "./engine.js";

type ReadHistoryRunner = Pick<Runner, "getHistory">;
type LoadHistoryRunner = Pick<Runner, "loadHistory">;

export function cloneChatHistory(
	messages: readonly ChatHistoryMessage[] | undefined | null,
): ChatHistoryMessage[] {
	return (messages ?? []).map((message) => ({ role: message.role, content: message.content }));
}

export function normalizeChatHistory(
	messages: readonly ChatHistoryMessage[] | undefined | null,
): ChatHistoryMessage[] {
	return (messages ?? [])
		.filter((message) => message.role === "user" || message.role === "assistant")
		.map((message) => ({
			role: message.role,
			content: typeof message.content === "string" ? message.content.trim() : "",
		}))
		.filter((message) => message.content.length > 0);
}

export function resolveSharedChatHistory(
	preferred: readonly ChatHistoryMessage[] | undefined | null,
	fallback: readonly ChatHistoryMessage[] | undefined | null,
): ChatHistoryMessage[] {
	const primary = normalizeChatHistory(preferred);
	if (primary.length > 0) return primary;
	return normalizeChatHistory(fallback);
}

export function handoffRunnerHistory(args: {
	activeRunner?: ReadHistoryRunner | null;
	targetRunner?: LoadHistoryRunner | null;
	sharedHistory?: readonly ChatHistoryMessage[] | undefined | null;
}): ChatHistoryMessage[] {
	const nextShared = resolveSharedChatHistory(
		args.activeRunner?.getHistory?.(),
		args.sharedHistory,
	);
	args.targetRunner?.loadHistory?.(cloneChatHistory(nextShared));
	return nextShared;
}
