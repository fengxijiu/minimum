import type { JsonRepairResult } from "../types/repair";
import {
	balanceBrackets,
	removeTrailingComma,
	repairTruncatedJson,
} from "../utils/json-repair";

export class JsonRepair {
	repair(input: string): JsonRepairResult {
		if (!input || !input.trim()) {
			return {
				repaired: "{}",
				changed: input !== "{}",
				description: "empty input",
				fallback: false,
			};
		}

		// 尝试直接解析
		try {
			JSON.parse(input);
			return {
				repaired: input,
				changed: false,
				description: "",
				fallback: false,
			};
		} catch {
			// 继续修复
		}

		// 使用工具函数修复
		const result = repairTruncatedJson(input);

		if (!result.fallback) {
			return result;
		}

		// 尝试其他修复方法
		let repaired = input;
		const descriptions: string[] = [];

		// 移除尾部逗号
		const withoutComma = removeTrailingComma(repaired);
		if (withoutComma !== repaired) {
			repaired = withoutComma;
			descriptions.push("removed trailing comma");
		}

		// 平衡括号
		const balanced = balanceBrackets(repaired);
		if (balanced !== repaired) {
			repaired = balanced;
			descriptions.push("balanced brackets");
		}

		// 验证修复结果
		try {
			JSON.parse(repaired);
			return {
				repaired,
				changed: true,
				description: descriptions.join(", "),
				fallback: false,
			};
		} catch {
			return {
				repaired: "{}",
				changed: true,
				description: "fallback to empty object",
				fallback: true,
			};
		}
	}
}
