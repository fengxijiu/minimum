import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatMessage } from "../types/common.js";
import { CheckpointManager } from "./CheckpointManager.js";
import type { SessionState } from "./types.js";

export interface LoopMeta {
	/** Accumulated turn cost in `totalCostCurrency` units (CNY or Credits). */
	totalCost?: number;
	totalCostCurrency?: "CNY" | "Credits";
	totalTokens?: number;
	totalPromptTokens?: number;
	totalCompletionTokens?: number;
	totalCachedTokens?: number;
	toolCalls?: number;
	steps?: number;
	model?: string;
}

export class SessionManager {
	private basePath: string;
	private checkpointManager: CheckpointManager;
	private currentSession: SessionState | null = null;

	constructor(basePath?: string) {
		// os.homedir() is cross-platform; $HOME alone is empty on Windows and
		// fell back to a literal "~" subdir of the cwd.
		this.basePath =
			basePath || path.join(os.homedir(), ".minimum", "sessions");
		this.checkpointManager = new CheckpointManager();
	}

	async initialize(): Promise<void> {
		await fsPromises.mkdir(this.basePath, { recursive: true });
		await this.checkpointManager.initialize();
	}

	/**
	 * 从 loop 状态持久化 — 每轮结束后调用。
	 * 首次调用时自动创建 session（无需提前 initialize()）。
	 */
	async persistFromLoop(messages: ChatMessage[], meta: LoopMeta): Promise<void> {
		if (!this.currentSession) {
			await fsPromises.mkdir(this.basePath, { recursive: true });
			this.currentSession = {
				id: `session_${Date.now()}`,
				messages: [],
				checkpoints: [],
				metadata: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
		}
		this.currentSession.messages = messages;
		this.currentSession.metadata = { ...this.currentSession.metadata, ...meta };
		await this.saveSession(this.currentSession);
		// 更新 last 指针，方便启动时恢复
		const lastPath = path.join(this.basePath, "last");
		await fsPromises.writeFile(lastPath, this.currentSession.id, "utf-8");
	}

	/**
	 * 进程退出前同步写盘（SIGINT 安全路径）。
	 */
	flushSync(): void {
		if (!this.currentSession) return;
		try {
			fs.mkdirSync(this.basePath, { recursive: true });
			this.currentSession.updatedAt = Date.now();
			const filePath = path.join(this.basePath, `${this.currentSession.id}.json`);
			fs.writeFileSync(filePath, JSON.stringify(this.currentSession, null, 2));
			fs.writeFileSync(path.join(this.basePath, "last"), this.currentSession.id, "utf-8");
		} catch {
			// best-effort; ignore errors during shutdown
		}
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
			const content = await fsPromises.readFile(filePath, "utf-8");
			const session = JSON.parse(content) as SessionState;

			this.currentSession = session;
			this.checkpointManager.setCurrentState(session);

			return session;
		} catch {
			return null;
		}
	}

	async loadLastSession(): Promise<SessionState | null> {
		try {
			// NEW: resume the most recently-persisted engine session from the `last` pointer.
			const lastId = (await fsPromises.readFile(path.join(this.basePath, "last"), "utf-8")).trim();
			if (!lastId) return null;
			return this.loadSession(lastId);
		} catch {
			return null;
		}
	}

	async saveSession(session: SessionState): Promise<void> {
		session.updatedAt = Date.now();
		const filePath = path.join(this.basePath, `${session.id}.json`);
		await fsPromises.writeFile(filePath, JSON.stringify(session, null, 2));
		// NEW: keep `last` aligned with any session we explicitly activate/save.
		await fsPromises.writeFile(path.join(this.basePath, "last"), session.id, "utf-8");
	}

	async addMessage(message: ChatMessage): Promise<void> {
		if (!this.currentSession) {
			await this.createSession();
		}

		this.currentSession?.messages.push(message);
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
			const files = await fsPromises.readdir(this.basePath);
			const sessions: SessionState[] = [];

			for (const file of files) {
				if (file.endsWith(".json")) {
					const content = await fsPromises.readFile(
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
