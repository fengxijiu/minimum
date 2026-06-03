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
