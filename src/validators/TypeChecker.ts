import type {
	IChecker,
	ValidationCheck,
	ValidationRequest,
} from "../types/validator.js";

/**
 * TypeChecker performs static analysis for common TypeScript/JavaScript type issues.
 * It identifies potential type-related problems without running a full type checker.
 */
export class TypeChecker implements IChecker {
	name = "type-checker";
	type = "type" as const;

	/**
	 * Checks for common type-related patterns in the code content.
	 * @param request - The validation request containing the code to analyze.
	 * @returns Array of validation checks highlighting type issues.
	 */
	async check(request: ValidationRequest): Promise<ValidationCheck[]> {
		const checks: ValidationCheck[] = [];

		// Analyze content for common type error patterns
		const content = request.toolResult.content;

		// 1. Check for undefined usage without typeof guard
		if (content.includes("undefined") && !content.includes("typeof")) {
			checks.push({
				name: this.name,
				type: this.type,
				passed: false,
				message: "Possible undefined usage without check",
				severity: "warning",
			});
		}

		// 2. Check for loose null comparisons
		if (content.includes("== null") || content.includes("!= null")) {
			checks.push({
				name: this.name,
				type: this.type,
				passed: false,
				message: "Use strict equality for null checks",
				severity: "info",
			});
		}

		// 3. Check for usage of 'any' type
		if (content.includes(": any") || content.includes("as any")) {
			checks.push({
				name: this.name,
				type: this.type,
				passed: false,
				message: "Avoid using any type",
				severity: "warning",
			});
		}

		// If no issues found, return a passing check
		if (checks.length === 0) {
			checks.push({
				name: this.name,
				type: this.type,
				passed: true,
				message: "Type check passed",
				severity: "info",
			});
		}

		return checks;
	}
}
