import type {
	IChecker,
	ICodeValidator,
	ValidationCheck,
	ValidationRequest,
	ValidationResult,
} from "../types/validator.js";
import { PatternChecker } from "./PatternChecker.js";
import { SyntaxChecker } from "./SyntaxChecker.js";
import { TscChecker } from "./TscChecker.js";
import { TypeChecker } from "./TypeChecker.js";

/**
 * Configuration options for CodeValidator.
 */
export interface CodeValidatorOptions {
	/** List of checker types to enable (e.g., ['syntax', 'type', 'pattern']). */
	enabledCheckers?: string[];
}

/**
 * CodeValidator orchestrates multiple code checkers to validate code quality.
 * It implements the ICodeValidator interface and manages checker registration and execution.
 */
export class CodeValidator implements ICodeValidator {
	private checkers: Map<string, IChecker> = new Map();
	private enabledTypes: Set<string>;

	/**
	 * Creates a new CodeValidator instance.
	 * @param options - Optional configuration for enabling specific checkers.
	 */
	constructor(options?: CodeValidatorOptions) {
		// Register default checkers
		this.registerChecker(new SyntaxChecker());
		this.registerChecker(new TscChecker()); // replaces TypeChecker for TS/JS files
		this.registerChecker(new TypeChecker());
		this.registerChecker(new PatternChecker());

		// Set enabled checker types based on options or defaults
		this.enabledTypes = new Set(
			options?.enabledCheckers || ["syntax", "type", "pattern"],
		);
	}

	/**
	 * Validates code by running all enabled checkers.
	 * @param request - The validation request containing code and metadata.
	 * @returns Validation result with checks, suggestions, and overall severity.
	 */
	async validate(request: ValidationRequest): Promise<ValidationResult> {
		const allChecks: ValidationCheck[] = [];

		// Run all enabled checkers
		for (const checker of this.checkers.values()) {
			if (this.enabledTypes.has(checker.type)) {
				try {
					const checks = await checker.check(request);
					allChecks.push(...checks);
				} catch (err) {
					// Capture checker execution errors as failed checks
					allChecks.push({
						name: checker.name,
						type: checker.type,
						passed: false,
						message: `Checker failed: ${err}`,
						severity: "error",
					});
				}
			}
		}

		// Calculate overall results
		const failedChecks = allChecks.filter((c) => !c.passed);
		const errorChecks = failedChecks.filter((c) => c.severity === "error");
		const warningChecks = failedChecks.filter((c) => c.severity === "warning");

		// Generate suggestions based on check results
		const suggestions: string[] = [];
		if (errorChecks.length > 0) {
			suggestions.push(`Fix ${errorChecks.length} error(s) before proceeding`);
		}
		if (warningChecks.length > 0) {
			suggestions.push(
				`Consider addressing ${warningChecks.length} warning(s)`,
			);
		}

		// Determine overall severity
		let severity: "error" | "warning" | "info" = "info";
		if (errorChecks.length > 0) {
			severity = "error";
		} else if (warningChecks.length > 0) {
			severity = "warning";
		}

		return {
			passed: errorChecks.length === 0,
			checks: allChecks,
			suggestions,
			severity,
		};
	}

	/**
	 * Registers a new checker with the validator.
	 * @param checker - The checker instance to register.
	 */
	registerChecker(checker: IChecker): void {
		this.checkers.set(checker.name, checker);
	}

	/**
	 * Enables or disables a specific checker type.
	 * @param type - The checker type to configure.
	 * @param enabled - Whether to enable or disable the checker.
	 */
	setCheckerEnabled(type: string, enabled: boolean): void {
		if (enabled) {
			this.enabledTypes.add(type);
		} else {
			this.enabledTypes.delete(type);
		}
	}
}
