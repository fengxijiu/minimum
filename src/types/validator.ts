import type { SourceLocation, ToolCall, ToolResult } from "./common";

export interface ValidationRequest {
	toolName: string;
	toolArgs: Record<string, any>;
	toolResult: ToolResult;
	filePath?: string;
	language?: string;
	workingDirectory?: string;
}

export interface ValidationCheck {
	name: string;
	type: "syntax" | "type" | "pattern" | "logic";
	passed: boolean;
	message: string;
	severity: "error" | "warning" | "info";
	location?: SourceLocation;
}

export interface ValidationResult {
	passed: boolean;
	checks: ValidationCheck[];
	suggestions: string[];
	severity: "error" | "warning" | "info";
}

export interface IChecker {
	name: string;
	type: "syntax" | "type" | "pattern" | "logic";
	check(request: ValidationRequest): Promise<ValidationCheck[]>;
}

export interface ICodeValidator {
	validate(request: ValidationRequest): Promise<ValidationResult>;
	registerChecker(checker: IChecker): void;
	setCheckerEnabled(type: string, enabled: boolean): void;
}
