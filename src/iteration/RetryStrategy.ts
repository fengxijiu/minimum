import type { ErrorRecord } from "../types/iteration";

export interface RetryConfig {
	maxRetries: number;
	backoffMs: number;
	backoffMultiplier: number;
	maxBackoffMs: number;
}

export class RetryStrategy {
	private config: RetryConfig;

	constructor(config?: Partial<RetryConfig>) {
		this.config = {
			maxRetries: config?.maxRetries ?? 3,
			backoffMs: config?.backoffMs ?? 1000,
			backoffMultiplier: config?.backoffMultiplier ?? 2,
			maxBackoffMs: config?.maxBackoffMs ?? 10000,
		};
	}

	shouldRetry(attempt: number, error: ErrorRecord): boolean {
		// 超过最大重试次数
		if (attempt >= this.config.maxRetries) {
			return false;
		}

		// 某些错误类型不重试
		if (error.type === "validation") {
			// 验证错误可以重试
			return true;
		}

		if (error.type === "timeout") {
			// 超时可以重试
			return true;
		}

		// 其他错误默认重试
		return true;
	}

	getDelay(attempt: number): number {
		const delay =
			this.config.backoffMs * Math.pow(this.config.backoffMultiplier, attempt);
		return Math.min(delay, this.config.maxBackoffMs);
	}

	getMaxRetries(): number {
		return this.config.maxRetries;
	}

	generateFixPrompt(
		task: string,
		failedResult: string,
		errors: string[],
		attempt: number,
		similarFixes: Array<{ problem: string; solution: string }>,
	): string {
		let prompt = `之前的实现有问题，请修复：

错误信息:
${errors.map((e) => `- ${e}`).join("\n")}

之前的代码:
\`\`\`
${failedResult}
\`\`\`
`;

		// 添加历史修复经验
		if (similarFixes.length > 0) {
			prompt += `
类似的修复经验:
${similarFixes.map((f) => `- 问题: ${f.problem}\n  解决方案: ${f.solution}`).join("\n")}
`;
		}

		// 添加特定于尝试次数的提示
		if (attempt === 1) {
			prompt += `
请仔细检查：
1. 是否有语法错误
2. 是否有类型错误
3. 是否有逻辑错误
`;
		} else if (attempt >= 2) {
			prompt += `
这是第${attempt + 1}次尝试，请：
1. 重新审视任务需求
2. 检查是否有遗漏的功能
3. 考虑边界条件
4. 简化实现方案
`;
		}

		return prompt;
	}
}
