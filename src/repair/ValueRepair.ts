import type { RepairContext, ToolSchema } from "../types/repair.js";

export class ValueRepair {
	async repair(
		args: Record<string, any>,
		schema: ToolSchema,
		context: RepairContext,
	): Promise<Record<string, any>> {
		const repaired = { ...args };

		for (const [key, value] of Object.entries(repaired)) {
			// 修复空字符串
			if (typeof value === "string" && value.trim() === "") {
				// 检查是否有默认值
				const propSchema = schema.properties[key];
				if (propSchema?.default !== undefined) {
					repaired[key] = propSchema.default;
				}
			}

			// 修复路径
			if (typeof value === "string" && this.isPathField(key)) {
				repaired[key] = this.repairPath(value, context);
			}
		}

		return repaired;
	}

	private isPathField(key: string): boolean {
		const pathFields = [
			"path",
			"filePath",
			"file",
			"directory",
			"dir",
			"location",
		];
		return pathFields.includes(key);
	}

	private repairPath(pathStr: string, context: RepairContext): string {
		// 移除多余的斜杠
		let repaired = pathStr.replace(/\/+/g, "/");

		// 如果是相对路径，转为绝对路径
		if (!repaired.startsWith("/") && !repaired.match(/^[A-Z]:\\/)) {
			repaired = `${context.workingDirectory}/${repaired}`;
		}

		return repaired;
	}
}
