import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * 创建临时目录
 */
export async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minimum-test-'));
}

/**
 * 清理临时目录
 */
export async function cleanupTempDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // 忽略错误
  }
}

/**
 * 创建临时文件
 */
export async function createTempFile(content: string, ext: string = '.ts'): Promise<string> {
  const dir = await createTempDir();
  const filePath = path.join(dir, `test${ext}`);
  await fs.writeFile(filePath, content);
  return filePath;
}

/**
 * 等待条件满足
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

/**
 * 捕获异步错误
 */
export async function captureError(fn: () => Promise<any>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error as Error;
  }
}

/**
 * 生成随机字符串
 */
export function randomString(length: number = 10): string {
  return Math.random().toString(36).substring(2, 2 + length);
}

/**
 * 生成随机整数
 */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 延迟执行
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 深度克隆
 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * 比较两个对象是否相等
 */
export function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
