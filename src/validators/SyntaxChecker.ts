import type {
	IChecker,
	ValidationCheck,
	ValidationRequest,
} from "../types/validator.js";
import {
	checkJsonSyntax,
	checkPythonSyntax,
	checkTypeScriptSyntax,
} from "../utils/syntax-checker.js";

/**
 * SyntaxChecker implements syntax validation for various file types.
 * It delegates to specific syntax checking functions based on file extension.
 */
export class SyntaxChecker implements IChecker {
	name = "syntax-checker";
	type = "syntax" as const;

	/**
	 * Performs syntax validation on the provided code content.
	 * @param request - The validation request containing file path and content.
	 * @returns Array of validation checks with results.
	 */
	async check(request: ValidationRequest): Promise<ValidationCheck[]> {
		const checks: ValidationCheck[] = [];

		// If no file path is provided, skip syntax checking
		if (!request.filePath) return checks;

		const ext = request.filePath.split(".").pop()?.toLowerCase();
		let result;

		// Select appropriate syntax checker based on file extension
		switch (ext) {
			case "json":
				result = checkJsonSyntax(request.toolResult.content);
				break;
			case "ts":
			case "tsx":
			case "js":
			case "jsx":
				result = checkTypeScriptSyntax(request.toolResult.content);
				break;
			case "py":
				result = checkPythonSyntax(request.toolResult.content);
				break;
			default:
				// Unsupported file type, return empty checks
				return checks;
		}

		// Process syntax check results
		if (!result.valid) {
			for (const error of result.errors) {
				checks.push({
					name: this.name,
					type: this.type,
					passed: false,
					message: error.message,
					severity: "error",
					location: request.filePath
						? {
								file: request.filePath,
								line: error.line,
								column: error.column,
							}
						: undefined,
				});
			}
		} else {
			checks.push({
				name: this.name,
				type: this.type,
				passed: true,
				message: "Syntax check passed",
				severity: "info",
			});
		}

		return checks;
	}
}
