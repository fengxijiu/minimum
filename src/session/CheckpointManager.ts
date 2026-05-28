import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatMessage } from "../types/common.js";
import type { Checkpoint, SessionState } from "./types.js";

export class CheckpointManager {
	private basePath: string;
	private currentState: SessionState | null = null;

	constructor(basePath?: string) {
		this.basePath =
			basePath || path.join(process.env.HOME || "~", ".minimum", "checkpoints");
	}

	async initialize(): Promise<void> {
		await fs.mkdir(this.basePath, { recursive: true });
	}

	async createCheckpoint(
		sessionId: string,
		messages: ChatMessage[],
		metadata: Record<string, any> = {},
	): Promise<Checkpoint> {
		const checkpoint: Checkpoint = {
			id: `cp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
			sessionId,
			messages: [...messages],
			metadata,
			createdAt: Date.now(),
		};

		await this.saveCheckpoint(checkpoint);

		if (this.currentState) {
			this.currentState.checkpoints.push(checkpoint);
		}

		return checkpoint;
	}

	async restoreCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
		try {
			const filePath = path.join(this.basePath, `${checkpointId}.json`);
			const content = await fs.readFile(filePath, "utf-8");
			return JSON.parse(content) as Checkpoint;
		} catch {
			return null;
		}
	}

	async listCheckpoints(sessionId?: string): Promise<Checkpoint[]> {
		try {
			const files = await fs.readdir(this.basePath);
			const checkpoints: Checkpoint[] = [];

			for (const file of files) {
				if (file.endsWith(".json")) {
					const content = await fs.readFile(
						path.join(this.basePath, file),
						"utf-8",
					);
					const checkpoint = JSON.parse(content) as Checkpoint;

					if (!sessionId || checkpoint.sessionId === sessionId) {
						checkpoints.push(checkpoint);
					}
				}
			}

			return checkpoints.sort((a, b) => b.createdAt - a.createdAt);
		} catch {
			return [];
		}
	}

	async deleteCheckpoint(checkpointId: string): Promise<boolean> {
		try {
			const filePath = path.join(this.basePath, `${checkpointId}.json`);
			await fs.unlink(filePath);
			return true;
		} catch {
			return false;
		}
	}

	private async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
		const filePath = path.join(this.basePath, `${checkpoint.id}.json`);
		await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2));
	}

	getCurrentState(): SessionState | null {
		return this.currentState;
	}

	setCurrentState(state: SessionState): void {
		this.currentState = state;
	}
}
