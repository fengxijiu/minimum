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

		const matches = code.match(/\b[A-Z][a-zA-Z0-9]*\b/g);
		if (matches) {
			for (const match of matches) {
				identifiers.add(match);
			}
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
