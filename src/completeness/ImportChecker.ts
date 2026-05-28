import type { CodeContext, CompletenessIssue } from "../types/completeness.js";

export class ImportChecker {
	async check(
		code: string,
		context: CodeContext,
	): Promise<CompletenessIssue[]> {
		const issues: CompletenessIssue[] = [];

		const usedIdentifiers = this.extractUsedIdentifiers(code);
		const importedIdentifiers = this.extractImportedIdentifiers(code);

		for (const identifier of usedIdentifiers) {
			if (!importedIdentifiers.has(identifier) && !this.isBuiltin(identifier)) {
				issues.push({
					type: "missing-import",
					severity: "error",
					message: `Missing import for: ${identifier}`,
					suggestedFix: `Add import for ${identifier}`,
				});
			}
		}

		for (const identifier of importedIdentifiers) {
			if (!usedIdentifiers.has(identifier)) {
				issues.push({
					type: "missing-import",
					severity: "info",
					message: `Unused import: ${identifier}`,
					suggestedFix: `Remove unused import for ${identifier}`,
				});
			}
		}

		return issues;
	}

	private extractUsedIdentifiers(code: string): Set<string> {
		const identifiers = new Set<string>();

		// Only match identifiers that appear in code-like contexts:
		// - new ClassName
		// - ClassName.method / ClassName.property
		// - functionName(  (but this is lowercase, handled separately)
		// - Type annotations: : ClassName, <ClassName>
		// Skip plain capitalized words in natural language sentences.

		// Pattern 1: new ClassName
		const newPattern = /\bnew\s+([A-Z][a-zA-Z0-9]*)/g;
		let match;
		while ((match = newPattern.exec(code)) !== null) {
			identifiers.add(match[1]!);
		}

		// Pattern 2: ClassName.something
		const dotPattern = /\b([A-Z][a-zA-Z0-9]*)\s*\./g;
		while ((match = dotPattern.exec(code)) !== null) {
			identifiers.add(match[1]!);
		}

		// Pattern 3: import/require statements
		const importPattern2 = /\b(?:import|require)\s*\(?\s*['"][^'"]*['"]/g;
		// These are handled by extractImportedIdentifiers

		// Pattern 4: Type annotations after : or as
		const typePattern = /(?::\s*|as\s+)([A-Z][a-zA-Z0-9]*)/g;
		while ((match = typePattern.exec(code)) !== null) {
			identifiers.add(match[1]!);
		}

		// Pattern 5: Generic type parameters <T>
		const genericPattern = /<([A-Z][a-zA-Z0-9]*)>/g;
		while ((match = genericPattern.exec(code)) !== null) {
			identifiers.add(match[1]!);
		}

		return identifiers;
	}

	private extractImportedIdentifiers(code: string): Set<string> {
		const identifiers = new Set<string>();

		const importPattern = /import\s+\{([^}]+)\}\s+from/g;
		let match;

		while ((match = importPattern.exec(code)) !== null) {
			const matchResult = match[1];
			if (matchResult) {
				const imports = matchResult.split(",").map((s) => s.trim());
				for (const imp of imports) {
					identifiers.add(imp);
				}
			}
		}

		return identifiers;
	}

	private isBuiltin(identifier: string): boolean {
		const builtins = [
			"console",
			"Math",
			"JSON",
			"Array",
			"Object",
			"String",
			"Number",
			"Boolean",
			"Date",
			"RegExp",
			"Map",
			"Set",
			"Promise",
			"Error",
			"TypeError",
			"ReferenceError",
			"SyntaxError",
		];
		return builtins.includes(identifier);
	}
}
