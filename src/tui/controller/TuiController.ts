import type { StreamChunk } from "../../clients/MiMoClient.js";
import { MiMoClient } from "../../clients/MiMoClient.js";
import { MiMoLoop } from "../../loop/MiMoLoop.js";
import { GrepTool, SearchTool } from "../../tools/search/GrepTool.js";
import { ExecShellTool } from "../../tools/shell/ExecShellTool.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";
import { ListDirectoryTool } from "../../tools/filesystem/ListDirectoryTool.js";
import { ReadFileTool } from "../../tools/filesystem/ReadFileTool.js";
import type { ChatMessage } from "../../types/common.js";
import { loopEventToTuiEvent, type TuiEvent } from "./events.js";

export interface TuiControllerOptions {
	workingDirectory?: string;
	useRealClient?: boolean;
}

class LocalEchoClient {
	async *streamChat(options: {
		messages: ChatMessage[];
	}): AsyncGenerator<StreamChunk> {
		const last = options.messages.at(-1)?.content ?? "";
		const text =
			`Minimum is running in local mock mode.\n\n` +
			`Received task: ${last}\n\n` +
			`Set MIMO_API_KEY to enable real MiMo streaming.`;
		yield { type: "content", content: text };
		yield {
			type: "usage",
			usage: {
				promptTokens: 0,
				completionTokens: text.length,
				totalTokens: text.length,
			},
		};
		yield { type: "done" };
	}
}

export class TuiController {
	private readonly workingDirectory: string;
	private readonly client: MiMoClient | LocalEchoClient;
	private readonly tools: ToolRegistry;
	private loop: MiMoLoop;
	private currentTurnId = 0;
	private running = false;

	constructor(options: TuiControllerOptions = {}) {
		this.workingDirectory = options.workingDirectory ?? process.cwd();
		this.tools = this.createDefaultTools();
		this.client =
			options.useRealClient ?? Boolean(process.env.MIMO_API_KEY)
				? new MiMoClient()
				: new LocalEchoClient();
		this.loop = this.createLoop();
	}

	get isRunning(): boolean {
		return this.running;
	}

	get cwd(): string {
		return this.workingDirectory;
	}

	async *runTurn(input: string): AsyncGenerator<TuiEvent> {
		if (this.running) {
			yield {
				type: "turn.error",
				turnId: this.currentTurnId,
				error: "A turn is already running",
				recoverable: true,
			};
			return;
		}

		const turnId = ++this.currentTurnId;
		this.running = true;
		yield { type: "turn.started", turnId, input };

		try {
			for await (const event of this.loop.run(input)) {
				if (turnId !== this.currentTurnId) break;
				const tuiEvent = loopEventToTuiEvent(turnId, event);
				if (tuiEvent) yield tuiEvent;
			}
		} finally {
			this.running = false;
		}
	}

	steer(text: string): void {
		this.loop.steer(text);
	}

	abort(): void {
		this.loop.abort();
	}

	reset(): void {
		this.abort();
		this.currentTurnId++;
		this.loop = this.createLoop();
		this.running = false;
	}

	private createLoop(): MiMoLoop {
		return new MiMoLoop({
			client: this.client,
			tools: this.tools,
			workingDirectory: this.workingDirectory,
		});
	}

	private createDefaultTools(): ToolRegistry {
		const registry = new ToolRegistry();
		registry.register(new ReadFileTool());
		registry.register(new ListDirectoryTool());
		registry.register(new GrepTool());
		registry.register(new SearchTool());

		if (process.env.MINIMUM_ENABLE_SHELL === "1") {
			registry.register(new ExecShellTool());
		}

		return registry;
	}
}
