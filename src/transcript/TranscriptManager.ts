import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatMessage } from "../types/common.js";
import type { ReplayOptions, Transcript, TranscriptEntry } from "./types.js";

export class TranscriptManager {
	private basePath: string;
	private currentTranscript: Transcript | null = null;
	private entryId = 0;

	constructor(basePath?: string) {
		this.basePath =
			basePath || path.join(process.env.HOME || "~", ".minimum", "transcripts");
	}

	async initialize(): Promise<void> {
		await fs.mkdir(this.basePath, { recursive: true });
	}

	async startTranscript(sessionId: string): Promise<Transcript> {
		const transcript: Transcript = {
			id: `transcript_${Date.now()}`,
			sessionId,
			entries: [],
			startTime: Date.now(),
			metadata: {},
		};

		this.currentTranscript = transcript;
		return transcript;
	}

	async addEntry(
		type: TranscriptEntry["type"],
		content: any,
		metadata?: Record<string, any>,
	): Promise<TranscriptEntry> {
		if (!this.currentTranscript) {
			throw new Error("No active transcript");
		}

		const entry: TranscriptEntry = {
			id: `entry_${++this.entryId}`,
			timestamp: Date.now(),
			type,
			content,
			metadata,
		};

		this.currentTranscript.entries.push(entry);
		return entry;
	}

	async addMessage(message: ChatMessage): Promise<TranscriptEntry> {
		return this.addEntry("message", message);
	}

	async addToolCall(toolName: string, args: any): Promise<TranscriptEntry> {
		return this.addEntry("tool_call", { toolName, args });
	}

	async addToolResult(toolName: string, result: any): Promise<TranscriptEntry> {
		return this.addEntry("tool_result", { toolName, result });
	}

	async addError(error: string): Promise<TranscriptEntry> {
		return this.addEntry("error", { error });
	}

	async addSystem(content: string): Promise<TranscriptEntry> {
		return this.addEntry("system", { content });
	}

	async endTranscript(): Promise<void> {
		if (this.currentTranscript) {
			this.currentTranscript.endTime = Date.now();
			await this.saveTranscript(this.currentTranscript);
			this.currentTranscript = null;
		}
	}

	async saveTranscript(transcript: Transcript): Promise<void> {
		const filePath = path.join(this.basePath, `${transcript.id}.json`);
		await fs.writeFile(filePath, JSON.stringify(transcript, null, 2));
	}

	async loadTranscript(transcriptId: string): Promise<Transcript | null> {
		try {
			const filePath = path.join(this.basePath, `${transcriptId}.json`);
			const content = await fs.readFile(filePath, "utf-8");
			return JSON.parse(content) as Transcript;
		} catch {
			return null;
		}
	}

	async listTranscripts(): Promise<Transcript[]> {
		try {
			const files = await fs.readdir(this.basePath);
			const transcripts: Transcript[] = [];

			for (const file of files) {
				if (file.endsWith(".json")) {
					const content = await fs.readFile(
						path.join(this.basePath, file),
						"utf-8",
					);
					transcripts.push(JSON.parse(content));
				}
			}

			return transcripts.sort((a, b) => b.startTime - a.startTime);
		} catch {
			return [];
		}
	}

	async *replay(
		transcriptId: string,
		options?: ReplayOptions,
	): AsyncGenerator<TranscriptEntry> {
		const transcript = await this.loadTranscript(transcriptId);
		if (!transcript) {
			throw new Error(`Transcript not found: ${transcriptId}`);
		}

		const speed = options?.speed || 1;
		const startFrom = options?.startFrom || 0;
		const stopAt = options?.stopAt || Number.POSITIVE_INFINITY;

		let lastTimestamp = transcript.startTime;

		for (const entry of transcript.entries) {
			// 过滤
			if (options?.filter && !options.filter(entry)) {
				continue;
			}

			// 时间控制
			const delay = (entry.timestamp - lastTimestamp) / speed;
			if (delay > 0) {
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
			lastTimestamp = entry.timestamp;

			// 范围控制
			if (entry.timestamp < startFrom) continue;
			if (entry.timestamp > stopAt) break;

			yield entry;
		}
	}

	async deleteTranscript(transcriptId: string): Promise<boolean> {
		try {
			const filePath = path.join(this.basePath, `${transcriptId}.json`);
			await fs.unlink(filePath);
			return true;
		} catch {
			return false;
		}
	}

	getCurrentTranscript(): Transcript | null {
		return this.currentTranscript;
	}
}
