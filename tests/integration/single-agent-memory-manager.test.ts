import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMiMoStack } from "../../src/config/createMiMoStack.js";
import { MockClient } from "../helpers/MockClient.js";
import { ToolRegistry } from "../../src/tools/ToolRegistry.js";

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
	for await (const _event of iterable) {
		// exhaust the loop so finally writeback has completed
	}
}

describe("SingleAgentMemoryManager integration", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;
	let globalMemoryDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "single-memory-"));
		projectA = path.join(tempDir, "project-a");
		projectB = path.join(tempDir, "project-b");
		globalMemoryDir = path.join(tempDir, "global-memory");
		await fs.mkdir(projectA, { recursive: true });
		await fs.mkdir(projectB, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("writes project memory, injects it on the next turn, and shares global memory across projectRoot", async () => {
		const firstClient = new MockClient();
		firstClient.setDefaultResponse("ok");
		const firstStack = createMiMoStack(
			firstClient,
			new ToolRegistry(),
			projectA,
			{ memory: { enabled: true, globalBasePath: globalMemoryDir } },
		);

		await drain(
			firstStack.loop.run(
				"Please remember for this project: use the Aurora API base URL for billing requests.",
			),
		);
		const firstWriteback = await firstStack.memoryManager?.impl.writebackRaw({
			projectRoot: projectA,
			input: "Remember globally: my preferred test runner is vitest.",
		});
		expect(firstWriteback?.globalWritten).toBe(1);

		const secondClient = new MockClient();
		secondClient.setDefaultResponse("ok");
		const secondStack = createMiMoStack(
			secondClient,
			new ToolRegistry(),
			projectA,
			{ memory: { enabled: true, globalBasePath: globalMemoryDir } },
		);
		await drain(secondStack.loop.run("How should billing requests call the API?"));

		const secondMessages = secondClient.getCallHistory()[0].messages;
		// Base-rules system prompt sits at index 0; memory is injected as a
		// system message too. Assert it appears among the system messages.
		const secondSystem = secondMessages.filter((m: { role: string }) => m.role === "system");
		expect(secondSystem.some((m: { content: string }) => m.content.includes("Aurora API base URL"))).toBe(true);

		const thirdClient = new MockClient();
		thirdClient.setDefaultResponse("ok");
		const thirdStack = createMiMoStack(
			thirdClient,
			new ToolRegistry(),
			projectB,
			{ memory: { enabled: true, globalBasePath: globalMemoryDir } },
		);
		await drain(thirdStack.loop.run("Which test runner do I prefer?"));

		const thirdMessages = thirdClient.getCallHistory()[0].messages;
		const thirdSystem = thirdMessages.filter((m: { role: string }) => m.role === "system");
		expect(thirdSystem.some((m: { content: string }) => m.content.includes("vitest"))).toBe(true);
	});
});
