import type { CompletenessIssue } from "../types/completeness.js";

/**
 * TaskCompletionChecker — P2-1 重写。
 *
 * 原来的关键词 diff 方案假阳性极高（任务描述里出现的词都会被检查是否在代码中），
 * 改为纯结构性检查：只在有高置信度证据时才报 issue。
 * 不使用模型自评（避免 MiMo 自评偏差 + 双倍 API 成本）。
 */
export class TaskCompletionChecker {
	async check(
		_task: string,
		code: string,
	): Promise<{ score: number; issues: CompletenessIssue[] }> {
		const issues: CompletenessIssue[] = [];
		let penalty = 0;

		// 1. TODO / FIXME / HACK 标记 — 明确的未完成信号
		const todoMatches = code.match(/\b(TODO|FIXME|HACK)\b[^\n]*/gi) ?? [];
		for (const match of todoMatches) {
			issues.push({
				type: "incomplete-part",
				severity: "error",
				message: `Incomplete marker found: ${match.trim().slice(0, 80)}`,
				suggestedFix: "Remove the marker and implement the missing part",
			});
			penalty += 15;
		}

		// 2. 明显的 stub 实现
		const stubPatterns = [
			/throw\s+new\s+Error\(\s*['"]not\s+implemented['"]/i,
			/throw\s+new\s+Error\(\s*['"]todo['"]/i,
			/raise\s+NotImplementedError/,
			/pass\s*#\s*(todo|stub|implement)/i,
		];
		for (const pat of stubPatterns) {
			if (pat.test(code)) {
				issues.push({
					type: "incomplete-part",
					severity: "error",
					message: "Stub implementation detected (not-implemented / placeholder throw)",
					suggestedFix: "Replace the stub with a real implementation",
				});
				penalty += 20;
				break;
			}
		}

		// 3. 代码主体几乎全是注释
		if (this.isMostlyComments(code)) {
			issues.push({
				type: "incomplete-part",
				severity: "error",
				message: "Code body is mostly comments with little actual implementation",
				suggestedFix: "Add real implementation beyond the comments",
			});
			penalty += 30;
		}

		// 4. TypeScript / JS @ts-ignore 过度使用（每处扣分）
		const tsIgnoreCount = (code.match(/@ts-ignore/g) ?? []).length;
		if (tsIgnoreCount >= 3) {
			issues.push({
				type: "incomplete-part",
				severity: "warning",
				message: `${tsIgnoreCount} @ts-ignore suppressions — may indicate unresolved type issues`,
				suggestedFix: "Fix the underlying type errors instead of suppressing them",
			});
			penalty += tsIgnoreCount * 3;
		}

		return {
			score: Math.max(0, 100 - penalty),
			issues,
		};
	}

	private isMostlyComments(code: string): boolean {
		const lines = code.split("\n").filter((l) => l.trim().length > 0);
		if (lines.length < 5) return false;
		const commentLines = lines.filter((l) => {
			const t = l.trim();
			return (
				t.startsWith("//") ||
				t.startsWith("#") ||
				t.startsWith("/*") ||
				t.startsWith("*")
			);
		});
		return commentLines.length > lines.length * 0.6;
	}
}
