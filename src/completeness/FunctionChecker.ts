import type { CompletenessIssue } from "../types/completeness.js";

export class FunctionChecker {
	async check(code: string): Promise<CompletenessIssue[]> {
		const issues: CompletenessIssue[] = [];

		const functions = this.extractFunctions(code);

		for (const func of functions) {
			if (func.body.includes("TODO") || func.body.includes("FIXME")) {
				issues.push({
					type: "placeholder-code",
					severity: "error",
					message: `Function ${func.name} contains TODO/FIXME marker`,
					location: func.location,
					suggestedFix: "Implement the missing functionality",
				});
			}

			if (this.isEmptyFunction(func.body)) {
				issues.push({
					type: "empty-function",
					severity: "warning",
					message: `Function ${func.name} has empty body`,
					location: func.location,
				});
			}

			if (this.hasPlaceholderCode(func.body)) {
				issues.push({
					type: "placeholder-code",
					severity: "error",
					message: `Function ${func.name} contains placeholder code`,
					location: func.location,
					suggestedFix: "Replace placeholder with actual implementation",
				});
			}
		}

		return issues;
	}

	private extractFunctions(code: string): Array<{
		name: string;
		body: string;
		location: { file: string; line: number; column: number };
	}> {
		const functions: Array<{
			name: string;
			body: string;
			location: { file: string; line: number; column: number };
		}> = [];

		const patterns = [
			/function\s+(\w+)\s*\([^)]*\)\s*\{([^}]*)\}/g,
			/(?:const|let|var)\s+(\w+)\s*=\s*(?:\([^)]*\)|[^=])\s*=>\s*\{([^}]*)\}/g,
			/(\w+)\s*\([^)]*\)\s*\{([^}]*)\}/g,
		];

		for (const pattern of patterns) {
			let match;
			while ((match = pattern.exec(code)) !== null) {
				const name = match[1];
				const body = match[2];

				const beforeMatch = code.slice(0, match.index);
				const lineNumber = beforeMatch.split("\n").length;

				if (name && body !== undefined) {
					functions.push({
						name,
						body,
						location: {
							file: "",
							line: lineNumber,
							column: 0,
						},
					});
				}
			}
		}

		return functions;
	}

	private isEmptyFunction(body: string): boolean {
		return !body || body.trim().length === 0;
	}

	private hasPlaceholderCode(body: string): boolean {
		const placeholders = [
			/pass\s*$/,
			/\.\.\./,
			/throw\s+new\s+Error\s*\(\s*['"]not\s+implemented/i,
			/return\s+null\s*;?\s*$/,
			/return\s+undefined\s*;?\s*$/,
		];

		return placeholders.some((p) => p.test(body));
	}
}
