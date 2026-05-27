import type { SourceLocation } from "./common";

export interface CodeContext {
	projectRoot: string;
	currentFile?: string;
	readFiles: string[];
	modifiedFiles: string[];
	language: string;
	relatedCode?: string[];
}

export interface CompletenessRequest {
	task: string;
	generatedCode: string;
	context: CodeContext;
	isTestTask?: boolean;
}

export interface CompletenessIssue {
	type:
		| "incomplete-function"
		| "missing-import"
		| "missing-error-handling"
		| "placeholder-code"
		| "empty-function"
		| "missing-return"
		| "missing-feature"
		| "incomplete-part";
	severity: "error" | "warning" | "info";
	message: string;
	location?: SourceLocation;
	suggestedFix?: string;
}

export interface RequiredAction {
	type:
		| "add-import"
		| "implement-function"
		| "add-error-handling"
		| "add-return"
		| "complete-implementation";
	description: string;
	targetFile?: string;
	targetLocation?: SourceLocation;
	suggestedCode?: string;
}

export interface CompletenessResult {
	complete: boolean;
	score: number;
	issues: CompletenessIssue[];
	suggestions: string[];
	requiredActions: RequiredAction[];
}

export interface ICompletenessChecker {
	check(request: CompletenessRequest): Promise<CompletenessResult>;
	checkFunctionCompleteness(code: string): Promise<CompletenessIssue[]>;
	checkImportCompleteness(
		code: string,
		context: CodeContext,
	): Promise<CompletenessIssue[]>;
	checkTaskCompletion(
		task: string,
		code: string,
	): Promise<{ score: number; issues: CompletenessIssue[] }>;
}
