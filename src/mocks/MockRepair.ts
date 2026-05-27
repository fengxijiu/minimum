export interface ToolCall {
	id?: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface RepairRequest {
	toolCall: ToolCall;
	toolDefinition?: any;
	context: any;
}

export interface RepairResult {
	toolCall: ToolCall;
	repaired: boolean;
	repairs: Array<{
		type: string;
		description: string;
		before: string;
		after: string;
		successful: boolean;
	}>;
	summary: string;
}

export class MockRepair {
	private mockResult: RepairResult | null = null;

	setResult(result: RepairResult): void {
		this.mockResult = result;
	}

	async repair(request: RepairRequest): Promise<RepairResult> {
		if (this.mockResult) {
			return this.mockResult;
		}

		return {
			toolCall: request.toolCall,
			repaired: false,
			repairs: [],
			summary: "No repairs needed",
		};
	}

	repairJson(json: string): {
		repaired: string;
		changed: boolean;
		description: string;
		fallback: boolean;
	} {
		try {
			JSON.parse(json);
			return {
				repaired: json,
				changed: false,
				description: "",
				fallback: false,
			};
		} catch {
			return {
				repaired: "{}",
				changed: true,
				description: "invalid json",
				fallback: true,
			};
		}
	}

	repairArgTypes(args: Record<string, any>, schema: any): Record<string, any> {
		return args;
	}

	async repairArgValues(
		args: Record<string, any>,
		schema: any,
		context: any,
	): Promise<Record<string, any>> {
		return args;
	}

	repairPath(pathStr: string, context: any): string {
		return pathStr;
	}
}
