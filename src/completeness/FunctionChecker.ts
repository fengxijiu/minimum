import type { CompletenessIssue } from "../types/completeness.js";

export class FunctionChecker {
	async check(code: string): Promise<CompletenessIssue[]> {
		const issues: CompletenessIssue[] = [];

		const functions = this.extractFunctions(code);

		for (const func of functions) {
			// The TODO/FIXME marker scan uses a string-stripped body so markers
			// inside string data aren't mistaken for real markers. The placeholder
			// scan below uses the raw body because it must inspect the string
			// argument of a not-implemented throw.
			const markerBody = func.body
				.replace(/`(?:\\[\s\S]|[^\\`])*`/g, '""')
				.replace(/'(?:\\.|[^\\'])*'/g, '""')
				.replace(/"(?:\\.|[^\\"])*"/g, '""');
			if (/\b(?:TODO|FIXME)\b\s*[:(]/.test(markerBody)) {
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

		// Control-flow / non-function keywords that the naive regexes below would
		// otherwise capture as "functions" (e.g. `if (x) { ... }`).
		const NON_FUNCTION = new Set([
			"if", "for", "while", "switch", "catch", "do", "else",
			"return", "function", "typeof", "await", "yield", "with",
		]);

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

				if (name && body !== undefined && !NON_FUNCTION.has(name)) {
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
		// Only unambiguous stubs. Spread/rest (`...`) and `return null/undefined`
		// are valid in real code and caused heavy false positives, so they are
		// intentionally excluded.
		const placeholders = [
			/\bpass\s*$/,
			/throw\s+new\s+Error\s*\(\s*['"]not\s+implemented/i,
			/raise\s+NotImplementedError/,
		];

		return placeholders.some((p) => p.test(body));
	}
}
