import { expect } from "vitest";

/**
 * 断言对象包含属性
 */
export function expectToHaveProperties(
	obj: any,
	...properties: string[]
): void {
	for (const prop of properties) {
		expect(obj).toHaveProperty(prop);
	}
}

/**
 * 断言数组非空
 */
export function expectNonEmptyArray(arr: any[]): void {
	expect(arr).toBeDefined();
	expect(Array.isArray(arr)).toBe(true);
	expect(arr.length).toBeGreaterThan(0);
}

/**
 * 断言字符串包含子串
 */
export function expectStringContains(str: string, substring: string): void {
	expect(str).toContain(substring);
}

/**
 * 断言日期有效
 */
export function expectValidDate(date: number | Date): void {
	const d = new Date(date);
	expect(d.getTime()).not.toBeNaN();
}

/**
 * 断言异步函数抛出错误
 */
export async function expectAsyncError(
	fn: () => Promise<any>,
	errorMessage?: string,
): Promise<Error> {
	try {
		await fn();
		throw new Error("Expected function to throw");
	} catch (error) {
		if (errorMessage) {
			expect((error as Error).message).toContain(errorMessage);
		}
		return error as Error;
	}
}

/**
 * 断言文件存在
 */
export async function expectFileExists(filePath: string): Promise<void> {
	const fs = await import("node:fs/promises");
	try {
		await fs.access(filePath);
	} catch {
		throw new Error(`Expected file to exist: ${filePath}`);
	}
}

/**
 * 断言目录存在
 */
export async function expectDirExists(dirPath: string): Promise<void> {
	const fs = await import("node:fs/promises");
	try {
		const stat = await fs.stat(dirPath);
		expect(stat.isDirectory()).toBe(true);
	} catch {
		throw new Error(`Expected directory to exist: ${dirPath}`);
	}
}
