import type { CompletenessIssue } from "../types/completeness";

export class ErrorHandlingChecker {
	async check(code: string): Promise<CompletenessIssue[]> {
		const issues: CompletenessIssue[] = [];

		const hasTryCatch = /try\s*\{/.test(code);
		const hasAsync = /await\s+|\.then\(|\.catch\(/.test(code);
		const hasFileOps = /readFile|writeFile|fs\.|path\./.test(code);
		const hasNetworkOps = /fetch|axios|http\.|https\./.test(code);

		if ((hasAsync || hasFileOps || hasNetworkOps) && !hasTryCatch) {
			issues.push({
				type: "missing-error-handling",
				severity: "warning",
				message: "Code has async operations but no error handling",
				suggestedFix: "Add try-catch block for error handling",
			});
		}

		const emptyCatchPattern = /catch\s*\([^)]*\)\s*\{\s*\}/g;
		if (emptyCatchPattern.test(code)) {
			issues.push({
				type: "missing-error-handling",
				severity: "warning",
				message: "Empty catch block found",
				suggestedFix: "Add error handling in catch block",
			});
		}

		return issues;
	}
}
