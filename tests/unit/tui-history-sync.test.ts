import { describe, expect, it, vi } from "vitest";
import type { ChatHistoryMessage, Runner } from "../../tui/src/engine.js";
import {
	cloneChatHistory,
	handoffRunnerHistory,
	normalizeChatHistory,
	resolveSharedChatHistory,
} from "../../tui/src/history-sync.js";

function fakeRunner(over: Partial<Runner> = {}): Runner {
	return {
		send: async function* () {},
		...over,
	};
}

describe("tui history sync", () => {
	it("normalizes history to user/assistant messages only", () => {
		const input: ChatHistoryMessage[] = [
			{ role: "system", content: "rules" },
			{ role: "user", content: "build upload flow" },
			{ role: "assistant", content: "", tool_calls: [{ id: "call_1" }] },
			{ role: "tool", content: "read_file output", tool_call_id: "call_1" },
			{ role: "assistant", content: "Implemented the upload flow.", tool_calls: [{ id: "call_2" }] },
			{ role: "assistant", content: "   " },
			{ role: "user", content: "add retries" },
			{ role: "assistant", content: "Added retries." },
		];

		expect(normalizeChatHistory(input)).toEqual([
			{ role: "user", content: "build upload flow" },
			{ role: "assistant", content: "Implemented the upload flow." },
			{ role: "user", content: "add retries" },
			{ role: "assistant", content: "Added retries." },
		]);
	});

	it("clones normalized history defensively", () => {
		const input: ChatHistoryMessage[] = [{ role: "user", content: "hello" }];
		const cloned = cloneChatHistory(input);
		cloned[0]!.content = "changed";
		expect(input[0]!.content).toBe("hello");
	});

	it("prefers normalized runner history and falls back to shared history when empty", () => {
		const shared: ChatHistoryMessage[] = [{ role: "assistant", content: "Pipeline summary" }];
		expect(resolveSharedChatHistory([{ role: "user", content: "hello" }], shared)).toEqual([
			{ role: "user", content: "hello" },
		]);
		expect(resolveSharedChatHistory([], shared)).toEqual(shared);
	});

	it("hands off normalized agent history to the orchestrate runner", () => {
		const targetLoadHistory = vi.fn();
		const activeRunner = fakeRunner({
			getHistory: () => [
				{ role: "system", content: "rules" },
				{ role: "user", content: "scan repo" },
				{ role: "assistant", content: "", tool_calls: [{ id: "tool_1" }] },
				{ role: "tool", content: "ls src", tool_call_id: "tool_1" },
				{ role: "assistant", content: "Repo scanned." },
			],
		});
		const targetRunner = fakeRunner({ loadHistory: targetLoadHistory });

		const shared = handoffRunnerHistory({
			activeRunner,
			targetRunner,
			sharedHistory: [],
		});

		expect(shared).toEqual([
			{ role: "user", content: "scan repo" },
			{ role: "assistant", content: "Repo scanned." },
		]);
		expect(targetLoadHistory).toHaveBeenCalledTimes(1);
		expect(targetLoadHistory).toHaveBeenCalledWith([
			{ role: "user", content: "scan repo" },
			{ role: "assistant", content: "Repo scanned." },
		]);
	});

	it("hands off orchestrate top-level history back to the single-agent runner", () => {
		const targetLoadHistory = vi.fn();
		const activeRunner = fakeRunner({
			getHistory: () => [
				{ role: "user", content: "build feature" },
				{ role: "assistant", content: "Pipeline completed with one skipped task." },
			],
		});
		const targetRunner = fakeRunner({ loadHistory: targetLoadHistory });

		const shared = handoffRunnerHistory({
			activeRunner,
			targetRunner,
			sharedHistory: [{ role: "user", content: "stale" }],
		});

		expect(shared).toEqual([
			{ role: "user", content: "build feature" },
			{ role: "assistant", content: "Pipeline completed with one skipped task." },
		]);
		expect(targetLoadHistory).toHaveBeenCalledWith(shared);
	});

	it("reuses shared history when the active runner has no usable history", () => {
		const targetLoadHistory = vi.fn();
		const targetRunner = fakeRunner({ loadHistory: targetLoadHistory });
		const sharedHistory: ChatHistoryMessage[] = [
			{ role: "user", content: "existing context" },
			{ role: "assistant", content: "Existing summary" },
		];

		const shared = handoffRunnerHistory({
			activeRunner: fakeRunner({ getHistory: () => [{ role: "tool", content: "ignored" }] }),
			targetRunner,
			sharedHistory,
		});

		expect(shared).toEqual(sharedHistory);
		expect(targetLoadHistory).toHaveBeenCalledWith(sharedHistory);
	});
});
