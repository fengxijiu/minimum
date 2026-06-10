import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IStreamingClient, IToolHost } from "../../src/loop/MiMoLoop.js";
import type { StreamChunk } from "../../src/clients/MiMoClient.js";
import type { ToolDefinition } from "../../src/types/common.js";
import type { Persona } from "../../src/personas/Persona.js";
import type { TaskContract } from "../../src/orchestration/TaskContract.js";
import { WorkerLoop } from "../../src/orchestration/WorkerLoop.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "minimum-wl-wt-test-"));
	execFileSync("git", [
		"-c", "user.email=t@t",
		"-c", "user.name=t",
		"init",
	], { cwd: tmpDir, stdio: "ignore" });
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// On Windows, git may hold file handles briefly — let the OS clean up.
	}
});

/** Records the `workingDirectory` passed to IToolHost.execute() for each call. */
function makeRecordingToolHost(): {
	host: IToolHost;
	recordedDirs: Array<string | undefined>;
} {
	const recordedDirs: Array<string | undefined> = [];
	const host: IToolHost = {
		getDefinitions(): ToolDefinition[] {
			return [
				{
					name: "read_file",
					description: "read a file",
					parameters: { type: "object", properties: {}, required: [] },
				},
			];
		},
		async execute(
			_toolCall: { function: { name: string; arguments: string } },
			context?: { signal?: AbortSignal; workingDirectory?: string },
		) {
			recordedDirs.push(context?.workingDirectory);
			return { content: "ok", isError: false };
		},
	};
	return { host, recordedDirs };
}

/**
 * A mock streaming client that emits one read_file tool call on the first turn,
 * then plain content on the second turn (no tool calls → loop exits cleanly).
 */
function makeToolCallingClient(): IStreamingClient {
	let turn = 0;
	return {
		streamChat(): AsyncIterable<StreamChunk> {
			const currentTurn = ++turn;
			const chunks: StreamChunk[] =
				currentTurn === 1
					? [
							{
								type: "tool_call",
								toolCall: {
									id: "tc-1",
									type: "function",
									function: { name: "read_file", arguments: '{"path":"test.txt"}' },
								},
							},
							{ type: "done" },
						]
					: [{ type: "content", content: "All done." }, { type: "done" }];

			return {
				[Symbol.asyncIterator]() {
					let i = 0;
					return {
						async next(): Promise<IteratorResult<StreamChunk>> {
							if (i < chunks.length) {
								return { done: false, value: chunks[i++]! };
							}
							return { done: true, value: undefined as unknown as StreamChunk };
						},
					};
				},
			};
		},
	};
}

const testPersona: Persona = {
	id: "code_executor",
	kind: "worker",
	model: "mimo-v2.5",
	systemPrompt: "you are a coder",
	toolAllowlist: ["read_file"],
	toolDenylist: [],
	pathPolicy: { canWrite: false, alwaysAllowedGlobs: [], forbiddenGlobs: [] },
	maxSteps: 10,
	maxTokens: 1000,
	outputSchema: "task_report",
	parallelism: { soloPerWave: false, maxConcurrent: 1 },
};

const testContract = {
	taskId: "test-task",
	grantedMcpTools: [],
} as unknown as TaskContract;

describe("WorkerLoop worktree write routing", () => {
	it("passes projectRoot as workingDirectory when worktreeIsolation is false", async () => {
		const { host, recordedDirs } = makeRecordingToolHost();

		const loop = new WorkerLoop({
			client: makeToolCallingClient(),
			tools: host,
			projectRoot: tmpDir,
			worktreeIsolation: false,
		});

		await loop.runTask({
			systemPrompt: "test",
			userPrompt: "read test.txt",
			persona: testPersona,
			contract: testContract,
			maxSteps: 5,
		});

		expect(recordedDirs.length).toBeGreaterThan(0);
		expect(recordedDirs[0]).toBe(tmpDir);
	});

	it("passes worktree path as workingDirectory when worktreeIsolation is true", async () => {
		// Create an initial commit so git worktree add has a valid base SHA.
		execFileSync("git", [
			"-c", "user.email=t@t",
			"-c", "user.name=t",
			"commit",
			"--allow-empty",
			"-m", "init",
		], { cwd: tmpDir, stdio: "ignore" });

		const { host, recordedDirs } = makeRecordingToolHost();

		const loop = new WorkerLoop({
			client: makeToolCallingClient(),
			tools: host,
			projectRoot: tmpDir,
			worktreeIsolation: true,
		});

		await loop.runTask({
			systemPrompt: "test",
			userPrompt: "read test.txt",
			persona: testPersona,
			contract: { ...testContract, taskId: "isolated-task" } as unknown as TaskContract,
			maxSteps: 5,
		});

		expect(recordedDirs.length).toBeGreaterThan(0);
		// The tool must have received the isolated worktree path, not the project root.
		expect(recordedDirs[0]).not.toBe(tmpDir);
		expect(recordedDirs[0]).toContain("minimum-wt-");
	});
});
