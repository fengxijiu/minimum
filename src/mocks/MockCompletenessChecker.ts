export interface CompletenessRequest {
	task: string;
	generatedCode: string;
	context: {
		projectRoot: string;
		currentFile?: string;
		readFiles: string[];
		modifiedFiles: string[];
		language: string;
	};
	isTestTask?: boolean;
}

export interface CompletenessResult {
	complete: boolean;
	score: number;
	issues: Array<{
		type: string;
		severity: string;
		message: string;
		location?: any;
		suggestedFix?: string;
	}>;
	suggestions: string[];
	requiredActions: Array<{
		type: string;
		description: string;
		targetFile?: string;
		suggestedCode?: string;
	}>;
}

export class MockCompletenessChecker {
	private mockResult: CompletenessResult = {
		complete: true,
		score: 100,
		issues: [],
		suggestions: [],
		requiredActions: [],
	};

	setResult(result: CompletenessResult): void {
		this.mockResult = result;
	}

	async check(request: CompletenessRequest): Promise<CompletenessResult> {
		return this.mockResult;
	}

	async checkFunctionCompleteness(code: string): Promise<any[]> {
		return [];
	}

	async checkImportCompleteness(code: string, context: any): Promise<any[]> {
		return [];
	}

	async checkTaskCompletion(
		task: string,
		code: string,
	): Promise<{ score: number; issues: any[] }> {
		return { score: 100, issues: [] };
	}
}
