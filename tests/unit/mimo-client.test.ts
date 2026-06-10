import { afterEach, describe, expect, it, vi } from "vitest";
import { MiMoClient, type StreamChunk } from "../../src/clients/MiMoClient.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

function sseResponse(body: string): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(body));
				controller.close();
			},
		}),
		{ status: 200 },
	);
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("MiMoClient.streamChat", () => {
	it("flushes pending tool calls and emits done when SSE closes without DONE", async () => {
		const body = [
			`data: ${JSON.stringify({
				choices: [
					{
						delta: {
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: { name: "read_file", arguments: '{"path"' },
								},
							],
						},
					},
				],
			})}`,
			`data: ${JSON.stringify({
				choices: [
					{
						delta: {
							tool_calls: [
								{
									function: { arguments: ':"src/a.ts"}' },
								},
							],
						},
					},
				],
			})}`,
		].join("\n");

		globalThis.fetch = vi.fn(async () => sseResponse(`${body}\n`)) as unknown as typeof fetch;
		const client = new MiMoClient({ apiKey: "sk-test", baseUrl: "https://example.test" });

		const chunks = await collect(client.streamChat({ messages: [] }));

		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toMatchObject({
			type: "tool_call",
			toolCall: {
				id: "call_1",
				function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
			},
		});
		expect(chunks[1]).toEqual({ type: "done" });
	});
});

describe("MiMoClient apiConcurrency", () => {
	it("throttles subsequent requests to 20 concurrent calls after the first 429", async () => {
		let callCount = 0;
		let active = 0;
		let peak = 0;
		const pending: Array<{ resolve: () => void }> = [];

		globalThis.fetch = vi.fn(() => {
			callCount += 1;
			if (callCount === 1) {
				return Promise.resolve(new Response("rate limited", { status: 429 }));
			}

			active += 1;
			peak = Math.max(peak, active);
			const ticket = deferred<void>();
			pending.push({
				resolve: () => {
					active -= 1;
					ticket.resolve();
				},
			});
			return ticket.promise.then(
				() =>
					new Response(
						JSON.stringify({
							id: `ok-${callCount}`,
							choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
							usage: {
								prompt_tokens: 1,
								completion_tokens: 1,
								total_tokens: 2,
							},
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
			);
		}) as unknown as typeof fetch;

		const client = new MiMoClient({
			apiKey: "sk-test",
			baseUrl: "https://example.test",
			apiConcurrency: {
				throttleOn429MaxConcurrent: 20,
				throttleWindowMs: 60_000,
			},
		});

		await expect(client.chat({ messages: [] })).rejects.toMatchObject({ statusCode: 429 });

		const requests = Array.from({ length: 21 }, () => client.chat({ messages: [] }));
		await Promise.resolve();
		await Promise.resolve();

		expect(callCount).toBe(21);
		expect(active).toBe(20);
		expect(peak).toBe(20);
		expect(pending).toHaveLength(20);

		pending.shift()!.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(callCount).toBe(22);
		expect(active).toBe(20);

		while (pending.length > 0) {
			pending.shift()!.resolve();
		}
		await Promise.all(requests);
	});
});
