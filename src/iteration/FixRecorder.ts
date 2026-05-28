import type { FixRecord } from "../types/iteration.js";
import { levenshteinSimilarity } from "../utils/similarity.js";

export class FixRecorder {
	private history: Map<string, FixRecord[]> = new Map();

	record(
		taskId: string,
		problem: string,
		solution: string,
		before: string,
		after: string,
		successful: boolean,
	): void {
		const records = this.history.get(taskId) || [];

		records.push({
			problem,
			solution,
			before,
			after,
			timestamp: Date.now(),
			successful,
		});

		this.history.set(taskId, records);
	}

	getHistory(taskId: string): FixRecord[] {
		return this.history.get(taskId) || [];
	}

	findSimilarFixes(problem: string, taskId?: string): FixRecord[] {
		const allFixes: FixRecord[] = [];

		if (taskId) {
			allFixes.push(...(this.history.get(taskId) || []));
		} else {
			for (const fixes of this.history.values()) {
				allFixes.push(...fixes);
			}
		}

		// 按相似度排序
		return allFixes
			.map((fix) => ({
				fix,
				similarity: levenshteinSimilarity(problem, fix.problem),
			}))
			.filter((item) => item.similarity > 0.5)
			.sort((a, b) => b.similarity - a.similarity)
			.map((item) => item.fix);
	}

	clearHistory(taskId?: string): void {
		if (taskId) {
			this.history.delete(taskId);
		} else {
			this.history.clear();
		}
	}
}
