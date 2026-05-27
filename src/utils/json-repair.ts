import type { JsonRepairResult } from "../types/repair";

export type { JsonRepairResult };

/**
 * 修复截断的JSON
 */
export function repairTruncatedJson(input: string): JsonRepairResult {
	const notes: string[] = [];
	if (!input || !input.trim()) {
		return {
			repaired: "{}",
			changed: input !== "{}",
			description: "empty input",
			fallback: false,
		};
	}

	try {
		JSON.parse(input);
		return {
			repaired: input,
			changed: false,
			description: "",
			fallback: false,
		};
	} catch {
		// fall through
	}

	const stack: ("{" | "[" | '"')[] = [];
	let escaped = false;
	let inString = false;
	let lastSignificant = -1;

	for (let i = 0; i < input.length; i++) {
		const c = input[i]!;
		if (!/\s/.test(c)) lastSignificant = i;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (c === "\\") {
				escaped = true;
				continue;
			}
			if (c === '"') {
				inString = false;
				stack.pop();
			}
			continue;
		}
		if (c === '"') {
			inString = true;
			stack.push('"');
			continue;
		}
		if (c === "{" || c === "[") stack.push(c);
		else if (c === "}" || c === "]") stack.pop();
	}

	let s = input.slice(0, lastSignificant + 1);

	if (/,$/.test(s)) {
		s = s.replace(/,$/, "");
		notes.push("trimmed trailing comma");
	}

	if (/"\s*:\s*$/.test(s)) {
		s += " null";
		notes.push("filled dangling key with null");
	}

	if (inString) {
		s += '"';
		stack.pop();
		notes.push("closed unterminated string");
	}

	while (stack.length > 0) {
		const top = stack.pop();
		if (top === "{") s += "}";
		else if (top === "[") s += "]";
		else if (top === '"') s += '"';
	}

	try {
		JSON.parse(s);
		return {
			repaired: s,
			changed: s !== input,
			description: notes.join(", "),
			fallback: false,
		};
	} catch (err) {
		return {
			repaired: "{}",
			changed: true,
			description: "fallback to {}",
			fallback: true,
		};
	}
}

/**
 * 平衡括号
 */
export function balanceBrackets(input: string): string {
	const stack: string[] = [];
	let result = input;

	for (const char of input) {
		if (char === "{" || char === "[" || char === "(") {
			stack.push(char);
		} else if (char === "}" || char === "]" || char === ")") {
			stack.pop();
		}
	}

	while (stack.length > 0) {
		const open = stack.pop();
		if (open === "{") result += "}";
		else if (open === "[") result += "]";
		else if (open === "(") result += ")";
	}

	return result;
}

/**
 * 移除尾部逗号
 */
export function removeTrailingComma(input: string): string {
	return input.replace(/,(\s*[}\]])/g, "$1");
}
