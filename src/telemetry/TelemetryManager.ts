import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionStats, TurnStats, UsageStats } from "./types.js";

export class TelemetryManager {
	private basePath: string;
	private currentSession: SessionStats | null = null;
	private turnIndex = 0;

	constructor(basePath?: string) {
		this.basePath =
			basePath || path.join(process.env.HOME || "~", ".minimum", "telemetry");
	}

	async initialize(): Promise<void> {
		await fs.mkdir(this.basePath, { recursive: true });
	}

	startSession(sessionId: string): void {
		this.currentSession = {
			sessionId,
			turns: [],
			totalTokens: 0,
			totalCost: 0,
			startTime: Date.now(),
		};
		this.turnIndex = 0;
	}

	recordTurn(stats: Omit<TurnStats, "turnIndex">): void {
		if (!this.currentSession) {
			return;
		}

		const turnStats: TurnStats = {
			turnIndex: ++this.turnIndex,
			...stats,
		};

		this.currentSession.turns.push(turnStats);
		this.currentSession.totalTokens += stats.tokens;
		this.currentSession.totalCost += stats.cost;
	}

	async endSession(): Promise<SessionStats | null> {
		if (!this.currentSession) {
			return null;
		}

		this.currentSession.endTime = Date.now();
		await this.saveSessionStats(this.currentSession);

		const stats = this.currentSession;
		this.currentSession = null;
		return stats;
	}

	getCurrentStats(): UsageStats | null {
		if (!this.currentSession) {
			return null;
		}

		return {
			totalTokens: this.currentSession.totalTokens,
			promptTokens: 0, // 需要从实际使用中计算
			completionTokens: 0,
			totalCost: this.currentSession.totalCost,
			toolCalls: this.currentSession.turns.reduce(
				(sum, t) => sum + t.toolCalls,
				0,
			),
			errors: this.currentSession.turns.filter((t) => !t.success).length,
			startTime: this.currentSession.startTime,
			endTime: this.currentSession.endTime,
		};
	}

	getTurnStats(): TurnStats[] {
		return this.currentSession?.turns || [];
	}

	private async saveSessionStats(stats: SessionStats): Promise<void> {
		const filePath = path.join(this.basePath, `${stats.sessionId}.json`);
		await fs.writeFile(filePath, JSON.stringify(stats, null, 2));
	}

	async loadSessionStats(sessionId: string): Promise<SessionStats | null> {
		try {
			const filePath = path.join(this.basePath, `${sessionId}.json`);
			const content = await fs.readFile(filePath, "utf-8");
			return JSON.parse(content) as SessionStats;
		} catch {
			return null;
		}
	}

	async listSessionStats(): Promise<SessionStats[]> {
		try {
			const files = await fs.readdir(this.basePath);
			const stats: SessionStats[] = [];

			for (const file of files) {
				if (file.endsWith(".json")) {
					const content = await fs.readFile(
						path.join(this.basePath, file),
						"utf-8",
					);
					stats.push(JSON.parse(content));
				}
			}

			return stats.sort((a, b) => b.startTime - a.startTime);
		} catch {
			return [];
		}
	}

	async getAggregateStats(): Promise<{
		totalSessions: number;
		totalTokens: number;
		totalCost: number;
		averageTokensPerSession: number;
		averageCostPerSession: number;
	}> {
		const allStats = await this.listSessionStats();

		const totalSessions = allStats.length;
		const totalTokens = allStats.reduce((sum, s) => sum + s.totalTokens, 0);
		const totalCost = allStats.reduce((sum, s) => sum + s.totalCost, 0);

		return {
			totalSessions,
			totalTokens,
			totalCost,
			averageTokensPerSession:
				totalSessions > 0 ? totalTokens / totalSessions : 0,
			averageCostPerSession: totalSessions > 0 ? totalCost / totalSessions : 0,
		};
	}
}
