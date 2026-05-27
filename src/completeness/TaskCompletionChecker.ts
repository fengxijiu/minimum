import type { CompletenessIssue } from "../types/completeness";

export class TaskCompletionChecker {
	async check(
		task: string,
		code: string,
	): Promise<{
		score: number;
		issues: CompletenessIssue[];
	}> {
		const issues: CompletenessIssue[] = [];
		let score = 100;

		const taskKeywords = this.extractKeywords(task);
		const codeKeywords = this.extractKeywords(code);

		for (const keyword of taskKeywords) {
			if (!codeKeywords.has(keyword)) {
				issues.push({
					type: "missing-feature",
					severity: "warning",
					message: `Task requirement "${keyword}" may not be implemented`,
					suggestedFix: `Implement functionality for: ${keyword}`,
				});
				score -= 10;
			}
		}

		if (this.isMostlyComments(code)) {
			issues.push({
				type: "incomplete-part",
				severity: "error",
				message:
					"Code appears to be mostly comments with little implementation",
				suggestedFix: "Add actual implementation",
			});
			score -= 30;
		}

		if (task.includes("return") && !code.includes("return")) {
			issues.push({
				type: "missing-return",
				severity: "warning",
				message: "Task mentions return value but code has no return statement",
				suggestedFix: "Add return statement",
			});
			score -= 15;
		}

		return {
			score: Math.max(0, score),
			issues,
		};
	}

	private extractKeywords(text: string): Set<string> {
		const keywords = new Set<string>();

		const words = text.match(/\b[a-zA-Z]{3,}\b/g);
		if (words) {
			for (const word of words) {
				const lower = word.toLowerCase();
				if (!this.isStopWord(lower)) {
					keywords.add(lower);
				}
			}
		}

		return keywords;
	}

	private isStopWord(word: string): boolean {
		const stopWords = new Set([
			"the",
			"and",
			"for",
			"are",
			"but",
			"not",
			"you",
			"all",
			"can",
			"has",
			"her",
			"was",
			"one",
			"our",
			"out",
			"this",
			"that",
			"with",
			"have",
			"from",
			"they",
			"been",
			"said",
			"each",
			"which",
			"their",
			"will",
			"other",
			"about",
			"many",
			"then",
			"them",
			"would",
			"like",
			"make",
			"could",
			"more",
			"than",
			"some",
			"very",
			"when",
			"come",
			"could",
			"what",
			"there",
			"use",
			"used",
			"using",
		]);
		return stopWords.has(word);
	}

	private isMostlyComments(code: string): boolean {
		const lines = code.split("\n");
		const commentLines = lines.filter((line) => {
			const trimmed = line.trim();
			return (
				trimmed.startsWith("//") ||
				trimmed.startsWith("#") ||
				trimmed.startsWith("/*") ||
				trimmed.startsWith("*")
			);
		});

		return commentLines.length > lines.length * 0.5;
	}
}
