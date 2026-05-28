import * as path from "path";
import * as fs from "fs/promises";
import type { ChatMessage } from "../types/common.js";

export interface SessionData {
	id: string;
	messages: ChatMessage[];
	metadata: Record<string, any>;
	createdAt: number;
	updatedAt: number;
}

export class SessionMemory {
	private basePath: string;
	private currentSession: SessionData | null = null;

	constructor(basePath?: string) {
		this.basePath =
			basePath || path.join(process.env.HOME || "~", ".minimum", "sessions");
	}

	async initialize(): Promise<void> {
		await fs.mkdir(this.basePath, { recursive: true });
	}

	async createSession(): Promise<SessionData> {
		const session: SessionData = {
			id: this.generateId(),
			messages: [],
			metadata: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		this.currentSession = session;
		await this.saveSession(session);

		return session;
	}

	async loadSession(id: string): Promise<SessionData | null> {
		try {
			const filePath = path.join(this.basePath, `${id}.json`);
			const content = await fs.readFile(filePath, "utf-8");
			const session = JSON.parse(content) as SessionData;
			this.currentSession = session;
			return session;
		} catch {
			return null;
		}
	}

	async saveSession(session: SessionData): Promise<void> {
		session.updatedAt = Date.now();
		const filePath = path.join(this.basePath, `${session.id}.json`);
		await fs.writeFile(filePath, JSON.stringify(session, null, 2));
	}

	async addMessage(message: ChatMessage): Promise<void> {
		if (!this.currentSession) {
			await this.createSession();
		}

		this.currentSession!.messages.push(message);
		await this.saveSession(this.currentSession!);
	}

	async getMessages(): Promise<ChatMessage[]> {
		return this.currentSession?.messages || [];
	}

	async listSessions(): Promise<SessionData[]> {
		try {
			const files = await fs.readdir(this.basePath);
			const sessions: SessionData[] = [];

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

	async deleteSession(id: string): Promise<boolean> {
		try {
			const filePath = path.join(this.basePath, `${id}.json`);
			await fs.unlink(filePath);

			if (this.currentSession?.id === id) {
				this.currentSession = null;
			}

			return true;
		} catch {
			return false;
		}
	}

	getCurrentSession(): SessionData | null {
		return this.currentSession;
	}

	private generateId(): string {
		return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	}
}
