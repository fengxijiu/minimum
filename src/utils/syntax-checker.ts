export interface SyntaxCheckResult {
	valid: boolean;
	errors: SyntaxError[];
}

export interface SyntaxError {
	message: string;
	line: number;
	column: number;
}

/**
 * 检查JSON语法
 */
export function checkJsonSyntax(code: string): SyntaxCheckResult {
	try {
		JSON.parse(code);
		return { valid: true, errors: [] };
	} catch (err: any) {
		const match = err.message.match(/position (\d+)/);
		const position = match ? Number.parseInt(match[1]) : 0;
		const lines = code.slice(0, position).split("\n");
		const lastLine = lines[lines.length - 1];

		return {
			valid: false,
			errors: [
				{
					message: err.message,
					line: lines.length,
					column: lastLine?.length || 0,
				},
			],
		};
	}
}

/**
 * 检查TypeScript/JavaScript语法（简化版本）
 * 注意：这是一个简化实现，完整实现需要使用TypeScript编译器API
 */
export function checkTypeScriptSyntax(code: string): SyntaxCheckResult {
	const errors: SyntaxError[] = [];
	const lines = code.split("\n");

	// 检查括号匹配
	const stack: Array<{ char: string; line: number; col: number }> = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;

		for (let j = 0; j < line.length; j++) {
			const char = line[j];
			if (!char) continue;

			if (char === "{" || char === "[" || char === "(") {
				stack.push({ char, line: i + 1, col: j + 1 });
			} else if (char === "}" || char === "]" || char === ")") {
				if (stack.length === 0) {
					errors.push({
						message: `Unmatched closing '${char}'`,
						line: i + 1,
						column: j + 1,
					});
				} else {
					const last = stack.pop()!;
					const expected =
						last.char === "{" ? "}" : last.char === "[" ? "]" : ")";
					if (char !== expected) {
						errors.push({
							message: `Mismatched brackets: expected '${expected}' but found '${char}'`,
							line: i + 1,
							column: j + 1,
						});
					}
				}
			}
		}
	}

	// 检查未闭合的括号
	while (stack.length > 0) {
		const last = stack.pop()!;
		errors.push({
			message: `Unclosed '${last.char}'`,
			line: last.line,
			column: last.col,
		});
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}

/**
 * 检查Python语法（简化版本）
 */
export function checkPythonSyntax(code: string): SyntaxCheckResult {
	const errors: SyntaxError[] = [];
	const lines = code.split("\n");

	// 检查缩进
	let expectedIndent = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line || !line.trim()) continue;

		const indent = line.search(/\S/);

		// 检查是否以冒号结尾（需要增加缩进）
		if (i > 0) {
			const prevLine = lines[i - 1];
			if (prevLine && prevLine.trim().endsWith(":")) {
				if (indent <= expectedIndent) {
					errors.push({
						message: "Expected indented block after colon",
						line: i + 1,
						column: indent + 1,
					});
				}
			}
		}

		expectedIndent = indent;
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}
