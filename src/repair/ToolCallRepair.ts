import type { ToolCall } from "../types/common.js";
import type {
	IToolCallRepair,
	JsonRepairResult,
	RepairContext,
	RepairRecord,
	RepairRequest,
	RepairResult,
	ToolSchema,
} from "../types/repair.js";
import { JsonRepair } from "./JsonRepair.js";
import { PathRepair } from "./PathRepair.js";
import { TypeRepair } from "./TypeRepair.js";
import { ValueRepair } from "./ValueRepair.js";

export class ToolCallRepair implements IToolCallRepair {
	private jsonRepair: JsonRepair;
	private typeRepair: TypeRepair;
	private valueRepair: ValueRepair;
	private pathRepair: PathRepair;

	constructor() {
		this.jsonRepair = new JsonRepair();
		this.typeRepair = new TypeRepair();
		this.valueRepair = new ValueRepair();
		this.pathRepair = new PathRepair();
	}

	async repair(request: RepairRequest): Promise<RepairResult> {
		const repairs: RepairRecord[] = [];
		const toolCall = { ...request.toolCall };
		const originalArgs = toolCall.function.arguments;

		// 1. JSON修复
		const jsonResult = this.repairJson(originalArgs);
		if (jsonResult.changed) {
			repairs.push({
				type: "json",
				description: jsonResult.description,
				before: originalArgs,
				after: jsonResult.repaired,
				successful: !jsonResult.fallback,
			});
			toolCall.function.arguments = jsonResult.repaired;
		}

		// 2. 如果JSON修复失败，直接返回
		if (jsonResult.fallback) {
			return {
				toolCall,
				repaired: true,
				repairs,
				summary: "JSON repair failed, returned empty object",
			};
		}

		// 3. 获取工具Schema
		const schema = request.context.toolSchemas[toolCall.function.name];
		if (!schema) {
			return {
				toolCall,
				repaired: repairs.length > 0,
				repairs,
				summary: repairs.length > 0 ? "JSON repaired" : "No repairs needed",
			};
		}

		// 4. 解析参数
		let args: Record<string, any>;
		try {
			args = JSON.parse(toolCall.function.arguments);
		} catch {
			return {
				toolCall,
				repaired: true,
				repairs: [
					...repairs,
					{
						type: "json",
						description: "Failed to parse arguments",
						before: toolCall.function.arguments,
						after: "{}",
						successful: false,
					},
				],
				summary: "Failed to parse arguments",
			};
		}

		// 5. 类型修复
		const typeRepaired = this.typeRepair.repair(args, schema);
		if (JSON.stringify(typeRepaired) !== JSON.stringify(args)) {
			repairs.push({
				type: "type",
				description: "Fixed type mismatches",
				before: JSON.stringify(args),
				after: JSON.stringify(typeRepaired),
				successful: true,
			});
			args = typeRepaired;
		}

		// 6. 值修复
		const valueRepaired = await this.valueRepair.repair(
			args,
			schema,
			request.context,
		);
		if (JSON.stringify(valueRepaired) !== JSON.stringify(args)) {
			repairs.push({
				type: "value",
				description: "Fixed invalid values",
				before: JSON.stringify(args),
				after: JSON.stringify(valueRepaired),
				successful: true,
			});
			args = valueRepaired;
		}

		// 7. 路径修复
		for (const [key, value] of Object.entries(args)) {
			if (typeof value === "string" && this.isPathField(key)) {
				const repairedPath = this.pathRepair.repair(value, request.context);
				if (repairedPath !== value) {
					repairs.push({
						type: "path",
						description: `Fixed path in ${key}`,
						before: value,
						after: repairedPath,
						successful: true,
					});
					args[key] = repairedPath;
				}
			}
		}

		// 8. 更新工具调用
		toolCall.function.arguments = JSON.stringify(args);

		return {
			toolCall,
			repaired: repairs.length > 0,
			repairs,
			summary:
				repairs.length > 0
					? `Repaired ${repairs.length} issue(s)`
					: "No repairs needed",
		};
	}

	repairJson(json: string): JsonRepairResult {
		return this.jsonRepair.repair(json);
	}

	repairArgTypes(
		args: Record<string, any>,
		schema: ToolSchema,
	): Record<string, any> {
		return this.typeRepair.repair(args, schema);
	}

	async repairArgValues(
		args: Record<string, any>,
		schema: ToolSchema,
		context: RepairContext,
	): Promise<Record<string, any>> {
		return this.valueRepair.repair(args, schema, context);
	}

	repairPath(pathStr: string, context: RepairContext): string {
		return this.pathRepair.repair(pathStr, context);
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
}
