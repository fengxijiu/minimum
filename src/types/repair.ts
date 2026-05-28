import type { ToolCall } from "./common.js";

export interface ToolSchema {
	name: string;
	properties: Record<string, PropertySchema>;
	required?: string[];
}

export interface PropertySchema {
	type: string;
	description?: string;
	default?: any;
	enum?: any[];
	format?: string;
}

export interface RepairContext {
	toolSchemas: Record<string, ToolSchema>;
	projectRoot: string;
	workingDirectory: string;
	readFiles: Set<string>;
	sessionHistory?: any[];
}

export interface RepairRequest {
	toolCall: ToolCall;
	toolDefinition?: any;
	context: RepairContext;
}

export interface RepairRecord {
	type: "json" | "type" | "value" | "path" | "schema";
	description: string;
	before: string;
	after: string;
	successful: boolean;
}

export interface RepairResult {
	toolCall: ToolCall;
	repaired: boolean;
	repairs: RepairRecord[];
	summary: string;
}

export interface JsonRepairResult {
	repaired: string;
	changed: boolean;
	description: string;
	fallback: boolean;
}

export interface IToolCallRepair {
	repair(request: RepairRequest): Promise<RepairResult>;
	repairJson(json: string): JsonRepairResult;
	repairArgTypes(
		args: Record<string, any>,
		schema: ToolSchema,
	): Record<string, any>;
	repairArgValues(
		args: Record<string, any>,
		schema: ToolSchema,
		context: RepairContext,
	): Promise<Record<string, any>>;
	repairPath(path: string, context: RepairContext): string;
}
