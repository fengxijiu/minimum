import type {
	IChecker,
	ValidationCheck,
	ValidationRequest,
} from "../types/validator.js";

/**
 * PatternChecker scans code content for predefined patterns that may indicate
 * issues such as debug statements, TODO markers, sensitive data, or security risks.
 */
export class PatternChecker implements IChecker {
	name = "pattern-checker";
	type = "pattern" as const;

	private patterns = [
		{
			pattern: /console\.log\(/g,
			message: "console.log found - consider removing for production",
			severity: "info" as const,
		},
		{
			pattern: /TODO|FIXME|HACK|XXX/g,
			message: "Found TODO/FIXME marker",
			severity: "warning" as const,
		},
		{
			pattern: /password|secret|api[_-]?key/gi,
			message: "Possible sensitive data found",
			severity: "error" as const,
		},
		{
			pattern: /eval\(/g,
			message: "eval() usage detected - potential security risk",
			severity: "error" as const,
		},
	];

	/**
	 * Checks code content against predefined patterns.
	 * @param request - The validation request containing the code to scan.
	 * @returns Array of validation checks for matched patterns.
	 */
	async check(request: ValidationRequest): Promise<ValidationCheck[]> {
		const checks: ValidationCheck[] = [];
		const content = request.toolResult.content;

		// Test each pattern against the content
		for (const { pattern, message, severity } of this.patterns) {
			const matches = content.match(pattern);
			if (matches) {
				checks.push({
					name: this.name,
					type: this.type,
					passed: false,
					message: `${message} (${matches.length} occurrences)`,
					severity,
				});
			}
		}

		// If no patterns matched, return a passing check
		if (checks.length === 0) {
			checks.push({
				name: this.name,
				type: this.type,
				passed: true,
				message: "Pattern check passed",
				severity: "info",
			});
		}

		return checks;
	}
}
