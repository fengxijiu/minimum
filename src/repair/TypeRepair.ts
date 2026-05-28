import type { ToolSchema } from "../types/repair.js";

export class TypeRepair {
	repair(args: Record<string, any>, schema: ToolSchema): Record<string, any> {
		const repaired = { ...args };

		for (const [key, propSchema] of Object.entries(schema.properties)) {
			if (!(key in repaired)) continue;

			const value = repaired[key];
			const expectedType = propSchema.type;

			// 修复类型不匹配
			switch (expectedType) {
				case "number":
					if (typeof value === "string") {
						const parsed = Number(value);
						if (!Number.isNaN(parsed)) {
							repaired[key] = parsed;
						}
					}
					break;

				case "string":
					if (typeof value === "number") {
						repaired[key] = String(value);
					}
					break;

				case "boolean":
					if (typeof value === "string") {
						if (value === "true") {
							repaired[key] = true;
						} else if (value === "false") {
							repaired[key] = false;
						}
					}
					break;

				case "array":
					if (typeof value === "string") {
						try {
							const parsed = JSON.parse(value);
							if (Array.isArray(parsed)) {
								repaired[key] = parsed;
							}
						} catch {
							// 保持原值
						}
					}
					break;

				case "object":
					if (typeof value === "string") {
						try {
							const parsed = JSON.parse(value);
							if (typeof parsed === "object" && !Array.isArray(parsed)) {
								repaired[key] = parsed;
							}
						} catch {
							// 保持原值
						}
					}
					break;
			}
		}

		return repaired;
	}
}
