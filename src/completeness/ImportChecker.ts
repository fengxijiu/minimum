import type { CodeContext, CompletenessIssue } from "../types/completeness.js";

export class ImportChecker {
	async check(
		code: string,
		context: CodeContext,
	): Promise<CompletenessIssue[]> {
		const issues: CompletenessIssue[] = [];

		// Strip comments first — capitalized words inside comments are prose, not
		// code, and were a major false-positive source.
		const stripped = this.stripComments(code);

		const usedIdentifiers = this.extractUsedIdentifiers(stripped);
		// "Available" = imported + locally declared (class/interface/type/enum).
		const availableIdentifiers = this.extractImportedIdentifiers(stripped);
		// Named imports only — basis for the unused-import check.
		const namedImports = this.extractNamedImports(stripped);

		for (const identifier of usedIdentifiers) {
			if (
				!availableIdentifiers.has(identifier) &&
				!this.isBuiltin(identifier) &&
				!this.isGenericParam(identifier)
			) {
				// Warning, not error: this is a regex heuristic that cannot match
				// every import/declaration form. The tsc validator authoritatively
				// catches real missing imports, so this must not gate completeness.
				issues.push({
					type: "missing-import",
					severity: "warning",
					message: `Possibly missing import for: ${identifier}`,
					suggestedFix: `Verify ${identifier} is imported or declared`,
				});
			}
		}

		for (const identifier of namedImports) {
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

	/**
	 * Remove comments and string/template literals so neither prose nor import
	 * path strings (e.g. "../clients/MiMoClient.js") masquerade as used code.
	 */
	private stripComments(code: string): string {
		return code
			.replace(/\/\*[\s\S]*?\*\//g, " ")
			.replace(/(^|[^:])\/\/[^\n]*/g, "$1")
			.replace(/`(?:\\[\s\S]|[^\\`])*`/g, '""')
			.replace(/'(?:\\.|[^\\'])*'/g, '""')
			.replace(/"(?:\\.|[^\\"])*"/g, '""');
	}

	/** Single-letter or `T1`-style generic type parameters are not imports. */
	private isGenericParam(identifier: string): boolean {
		return /^[A-Z][0-9]?$/.test(identifier);
	}

	private extractUsedIdentifiers(code: string): Set<string> {
		const identifiers = new Set<string>();

		// Only match identifiers that appear in code-like contexts:
		// - new ClassName
		// - ClassName.method / ClassName.property
		// - functionName(  (but this is lowercase, handled separately)
		// - Type annotations: : ClassName, <ClassName>
		// Skip plain capitalized words in natural language sentences.

		// Identifier char class includes `_`/`$` so boundaries match the
		// declaration extractor (e.g. TOOL_KIND, not just TOOL).
		// Pattern 1: new ClassName
		const newPattern = /\bnew\s+([A-Z][\w$]*)/g;
		let match;
		while ((match = newPattern.exec(code)) !== null) {
			identifiers.add(match[1]!);
		}

		// Pattern 2: ClassName.something
		const dotPattern = /\b([A-Z][\w$]*)\s*\./g;
		while ((match = dotPattern.exec(code)) !== null) {
			identifiers.add(match[1]!);
		}

		// Pattern 4: Type annotations after : or as
		const typePattern = /(?::\s*|as\s+)([A-Z][\w$]*)/g;
		while ((match = typePattern.exec(code)) !== null) {
			identifiers.add(match[1]!);
		}

		// Pattern 5: Generic type parameters <T>
		const genericPattern = /<([A-Z][\w$]*)>/g;
		while ((match = genericPattern.exec(code)) !== null) {
			identifiers.add(match[1]!);
		}

		return identifiers;
	}

	/** Named import bindings only (`import { a, b as c }` / `import type { ... }`). */
	private extractNamedImports(code: string): Set<string> {
		const identifiers = new Set<string>();
		const namedPattern = /import\s+(?:type\s+)?\{([^}]+)\}\s+from/g;
		let match;
		while ((match = namedPattern.exec(code)) !== null) {
			const inner = match[1];
			if (!inner) continue;
			for (const raw of inner.split(",")) {
				const parts = raw.trim().split(/\s+as\s+/);
				const name = (parts[1] ?? parts[0])?.trim();
				if (name) identifiers.add(name);
			}
		}
		return identifiers;
	}

	/**
	 * Identifiers that are "available" in the file: named imports (incl.
	 * `import type`), default & namespace imports, and locally declared
	 * classes / interfaces / types / enums / functions / consts.
	 */
	private extractImportedIdentifiers(code: string): Set<string> {
		const identifiers = new Set<string>();
		let match;

		// Named imports: import { a, b as c } from ...  /  import type { ... } from ...
		const namedPattern = /import\s+(?:type\s+)?\{([^}]+)\}\s+from/g;
		while ((match = namedPattern.exec(code)) !== null) {
			const inner = match[1];
			if (!inner) continue;
			for (const raw of inner.split(",")) {
				// handle "Foo as Bar" → the local binding is Bar
				const parts = raw.trim().split(/\s+as\s+/);
				const name = (parts[1] ?? parts[0])?.trim();
				if (name) identifiers.add(name);
			}
		}

		// Default & namespace imports: import Foo from ... / import * as Foo from ...
		// import type Foo from ...
		const defaultPattern =
			/import\s+(?:type\s+)?(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from/g;
		while ((match = defaultPattern.exec(code)) !== null) {
			if (match[1] && match[1] !== "type") identifiers.add(match[1]);
		}

		// Local declarations — used identifiers defined in the same file are not
		// "missing imports".
		const declPattern =
			/\b(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
		while ((match = declPattern.exec(code)) !== null) {
			if (match[1]) identifiers.add(match[1]);
		}

		return identifiers;
	}

	private isBuiltin(identifier: string): boolean {
		const builtins = new Set([
			// Global objects
			"console", "Math", "JSON", "Array", "Object", "String", "Number",
			"Boolean", "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet",
			"Promise", "Symbol", "BigInt", "Proxy", "Reflect", "Buffer",
			"Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError",
			"Function", "Infinity", "NaN", "JSON", "Intl",
			"Uint8Array", "Int32Array", "Float64Array", "ArrayBuffer",
			"AbortController", "AbortSignal", "URL", "URLSearchParams",
			"TextEncoder", "TextDecoder",
			// Common ambient globals / DOM-ish
			"Process", "Node", "Document", "Window", "Element", "Event",
			// TS utility types
			"Partial", "Required", "Readonly", "Record", "Pick", "Omit",
			"Exclude", "Extract", "NonNullable", "Parameters", "ReturnType",
			"InstanceType", "Awaited", "ThisType", "Uppercase", "Lowercase",
			"Capitalize", "Uncapitalize", "Iterable", "AsyncIterable",
			"Iterator", "AsyncGenerator", "Generator", "ReadonlyArray",
		]);
		return builtins.has(identifier);
	}
}
