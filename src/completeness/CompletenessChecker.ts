import type {
	CodeContext,
	CompletenessIssue,
	CompletenessRequest,
	CompletenessResult,
	ICompletenessChecker,
	RequiredAction,
} from "../types/completeness.js";
import { ErrorHandlingChecker } from "./ErrorHandlingChecker.js";
import { FunctionChecker } from "./FunctionChecker.js";
import { ImportChecker } from "./ImportChecker.js";
import { TaskCompletionChecker } from "./TaskCompletionChecker.js";

export class CompletenessChecker implements ICompletenessChecker {
	private functionChecker: FunctionChecker;
	private importChecker: ImportChecker;
	private errorHandlingChecker: ErrorHandlingChecker;
	private taskCompletionChecker: TaskCompletionChecker;

	constructor() {
		this.functionChecker = new FunctionChecker();
		this.importChecker = new ImportChecker();
		this.errorHandlingChecker = new ErrorHandlingChecker();
		this.taskCompletionChecker = new TaskCompletionChecker();
	}

	async check(request: CompletenessRequest): Promise<CompletenessResult> {
		const issues: CompletenessIssue[] = [];

		const functionIssues = await this.checkFunctionCompleteness(
			request.generatedCode,
		);
		issues.push(...functionIssues);

		const importIssues = await this.checkImportCompleteness(
			request.generatedCode,
			request.context,
		);
		issues.push(...importIssues);

		const errorHandlingIssues = await this.errorHandlingChecker.check(
			request.generatedCode,
		);
		issues.push(...errorHandlingIssues);

		const { score, issues: taskIssues } = await this.checkTaskCompletion(
			request.task,
			request.generatedCode,
		);
		issues.push(...taskIssues);

		const suggestions = this.generateSuggestions(issues);
		const requiredActions = this.generateRequiredActions(issues);

		const errorIssues = issues.filter((i) => i.severity === "error");
		const complete = errorIssues.length === 0;

		return {
			complete,
			score,
			issues,
			suggestions,
			requiredActions,
		};
	}

	async checkFunctionCompleteness(code: string): Promise<CompletenessIssue[]> {
		return this.functionChecker.check(code);
	}

	async checkImportCompleteness(
		code: string,
		context: CodeContext,
	): Promise<CompletenessIssue[]> {
		return this.importChecker.check(code, context);
	}

	async checkTaskCompletion(
		task: string,
		code: string,
	): Promise<{
		score: number;
		issues: CompletenessIssue[];
	}> {
		return this.taskCompletionChecker.check(task, code);
	}

	private generateSuggestions(issues: CompletenessIssue[]): string[] {
		const suggestions: string[] = [];

		const errorIssues = issues.filter((i) => i.severity === "error");
		const warningIssues = issues.filter((i) => i.severity === "warning");

		if (errorIssues.length > 0) {
			suggestions.push(`Fix ${errorIssues.length} critical issue(s)`);
		}

		if (warningIssues.length > 0) {
			suggestions.push(`Address ${warningIssues.length} warning(s)`);
		}

		for (const issue of issues) {
			if (issue.suggestedFix) {
				suggestions.push(issue.suggestedFix);
			}
		}

		return [...new Set(suggestions)];
	}

	private generateRequiredActions(
		issues: CompletenessIssue[],
	): RequiredAction[] {
		const actions: RequiredAction[] = [];

		for (const issue of issues) {
			if (issue.severity === "error") {
				actions.push({
					type: issue.type as RequiredAction["type"],
					description: issue.message,
					targetFile: issue.location?.file,
					suggestedCode: issue.suggestedFix,
				});
			}
		}

		return actions;
	}
}
