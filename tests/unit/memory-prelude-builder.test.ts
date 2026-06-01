import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StreamChunk } from "../../src/clients/MiMoClient.js";
import { MiMoLoop } from "../../src/loop/MiMoLoop.js";
import {
	MEMORY_PRELUDE_MARKER,
	buildPrelude,
} from "../../src/memory/single/MemoryPreludeBuilder.js";
import { MemoryStore } from "../../src/memory/MemoryStore.js";
import { ProjectMemory } from "../../src/memory/ProjectMemory.js";
import type { ChatMessage, ToolDefinition } from "../../src/types/common.js";

class CapturingClient {
	readonly calls: ChatMessage[][] = [];

	async *streamChat(options: { messages: ChatMessage[] }): AsyncIterable<StreamChunk> {
		this.calls.push(options.messages.map((message) => ({ ...message })));
		yield { type: "content", content: "done" } as StreamChunk;
	}
}

const emptyTools = {
	getDefinitions(): ToolDefinition[] {
		return [];
	},
	async execute() {
		return { content: "" };
	},
};

describe("MemoryPreludeBuilder", () => {
	let tempDir: string;
	let globalDir: string;
	let projectMemory: ProjectMemory;
	let globalMemory: MemoryStore;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-prelude-project-"));
		globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-prelude-global-"));
		projectMemory = new ProjectMemory(tempDir);
		globalMemory = new MemoryStore({ basePath: globalDir });
		await Promise.all([projectMemory.initialize(), globalMemory.initialize()]);
	});

	afterEach(async () => {
		await Promise.all([
			fs.rm(tempDir, { recursive: true, force: true }),
			fs.rm(globalDir, { recursive: true, force: true }),
		]);
	});

	it("builds a ranked markdown prelude with included record ids", async () => {
		await projectMemory.set("typescript-style", "Prefer strict TypeScript for service code.");
		await globalMemory.set({
			key: "typescript-personal",
			value: "The user likes concise TypeScript examples.",
			type: "user",
			timestamp: Date.now(),
			metadata: { confidence: "high" },
		});
		await globalMemory.set({
			key: "python-personal",
			value: "Python notes should mention pytest.",
			type: "user",
			timestamp: Date.now(),
			metadata: { confidence: "high" },
		});

		const result = await buildPrelude({
			userInput: "Please update the TypeScript service",
			workingDirectory: tempDir,
			messages: [],
			tokenBudget: 400,
			projectMemory,
			globalMemory,
		});

		expect(result.prelude).toContain(MEMORY_PRELUDE_MARKER);
		expect(result.prelude).toContain("## Relevant memory");
		expect(result.includedRecordIds).toContain("project:typescript-style");
		expect(result.includedRecordIds).toContain("global:typescript-personal");
		expect(result.includedRecordIds).not.toContain("global:python-personal");
	});

	it("replaces the memory system message across multiple runs instead of stacking it", async () => {
		await projectMemory.set("typescript-style", "Prefer strict TypeScript for service code.");
		const client = new CapturingClient();
		const persisted: ChatMessage[][] = [];
		const loop = new MiMoLoop({
			client,
			tools: emptyTools,
			workingDirectory: tempDir,
			maxSteps: 2,
			memoryPrelude: { projectMemory, globalMemory, tokenBudget: 300 },
			sessionPersister: {
				async persistFromLoop(messages) {
					persisted.push(messages.map((message) => ({ ...message })));
				},
				flushSync() {},
			},
		});

		for await (const _event of loop.run("Update the TypeScript service")) {
			// drain the first turn
		}
		for await (const _event of loop.run("Continue the TypeScript work")) {
			// drain the second turn
		}

		expect(client.calls).toHaveLength(2);
		for (const callMessages of client.calls) {
			const memoryMessages = callMessages.filter((message) =>
				message.content.includes(MEMORY_PRELUDE_MARKER),
			);
			expect(memoryMessages).toHaveLength(1);
			expect(memoryMessages[0]?.role).toBe("system");
		}
		expect(
			loop
				.getMessages()
				.filter((message) => message.content.includes(MEMORY_PRELUDE_MARKER)),
		).toHaveLength(1);
		expect(persisted).toHaveLength(2);
		for (const persistedMessages of persisted) {
			expect(
				persistedMessages.some((message) =>
					message.content.includes(MEMORY_PRELUDE_MARKER),
				),
			).toBe(false);
		}
	});
});
