import * as path from "path";
import * as fs from "fs/promises";
import type { ChatMessage } from "../types/common.js";
import { CheckpointManager } from "./CheckpointManager.js";
import type { SessionState } from "./types.js";

export class SessionManager {
	private basePath: string;
	private checkpointManager: CheckpointManager;
	private currentSession: SessionState | null = null;

	constructor(basePath?: string) {
		this.basePath =
			basePath || path.join(process.env.HOME || "~", ".minimum", "sessions");
		this.checkpointManager = new CheckpointManager();
	}

	async initialize(): Promise<void> {
		await fs.mkdir(this.basePath, { recursive: true });
		await this.checkpointManager.initialize();
	}

	async createSession(name?: string): Promise<SessionState> {
		const session: SessionState = {
			id: name || `session_${Date.now()}`,
			messages: [],
			checkpoints: [],
			metadata: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		this.currentSession = session;
		await this.saveSession(session);

		return session;
	}

	async loadSession(sessionId: string): Promise<SessionState | null> {
		try {
			const filePath = path.join(this.basePath, `${sessionId}.json`);
			const content = await fs.readFile(filePath, "utf-8");
			const session = JSON.parse(content) as SessionState;

			this.currentSession = session;
			this.checkpointManager.setCurrentState(session);

			return session;
		} catch {
			return null;
		}
	}

	async saveSession(session: SessionState): Promise<void> {
		session.updatedAt = Date.now();
		const filePath = path.join(this.basePath, `${session.id}.json`);
		await fs.writeFile(filePath, JSON.stringify(session, null, 2));
	}

	async addMessage(message: ChatMessage): Promise<void> {
		if (!this.currentSession) {
			await this.createSession();
		}

		this.currentSession!.messages.push(message);
		this.currentSession!.updatedAt = Date.now();
	}

	async createCheckpoint(metadata: Record<string, any> = {}): Promise<string> {
		if (!this.currentSession) {
			throw new Error("No active session");
		}

		const checkpoint = await this.checkpointManager.createCheckpoint(
			this.currentSession.id,
			this.currentSession.messages,
			metadata,
		);

		return checkpoint.id;
	}

	async restoreCheckpoint(checkpointId: string): Promise<boolean> {
		const checkpoint =
			await this.checkpointManager.restoreCheckpoint(checkpointId);

		if (!checkpoint) {
			return false;
		}

		if (this.currentSession) {
			this.currentSession.messages = [...checkpoint.messages];
			this.currentSession.updatedAt = Date.now();
			await this.saveSession(this.currentSession);
		}

		return true;
	}

	async listSessions(): Promise<SessionState[]> {
		try {
			const files = await fs.readdir(this.basePath);
			const sessions: SessionState[] = [];

			for (const file of files) {
				if (file.endsWith(".json")) {
					const content = await fs.readFile(
						path.join(this.basePath, file),
						"utf-8",
					);
					sessions.push(JSON.parse(content));
				}
			}

			return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
		} catch {
			return [];
		}
	}

	async listCheckpoints(): Promise<any[]> {
		if (!this.currentSession) {
			return [];
		}
		return this.checkpointManager.listCheckpoints(this.currentSession.id);
	}

	getCurrentSession(): SessionState | null {
		return this.currentSession;
	}

	getMessages(): ChatMessage[] {
		return this.currentSession?.messages || [];
	}
}
