export interface ValidationRequest {
	toolName: string;
	toolArgs: Record<string, any>;
	toolResult: { content: string; isError?: boolean };
	filePath?: string;
	language?: string;
}

export interface ValidationResult {
	passed: boolean;
	checks: Array<{
		name: string;
		type: string;
		passed: boolean;
		message: string;
		severity: string;
	}>;
	suggestions: string[];
	severity: "error" | "warning" | "info";
}

export interface IChecker {
	name: string;
	type: string;
	check(request: ValidationRequest): Promise<any[]>;
}

export class MockValidator {
	private mockResult: ValidationResult = {
		passed: true,
		checks: [],
		suggestions: [],
		severity: "info",
	};

	setResult(result: ValidationResult): void {
		this.mockResult = result;
	}

	async validate(request: ValidationRequest): Promise<ValidationResult> {
		return this.mockResult;
	}

	registerChecker(checker: IChecker): void {
		// Mock: no-op
	}

	setCheckerEnabled(type: string, enabled: boolean): void {
		// Mock: no-op
	}
}
