import { describe, expect, it } from "vitest";
import { runCommand, DEFAULT_TIMEOUT_SEC, DEFAULT_MAX_OUTPUT_CHARS } from "../../src/tools/shell/exec.js";

describe("runCommand", () => {
	it("成功执行 node -e 输出 hello", async () => {
		const r = await runCommand('node -e "console.log(\\"hello\\")"', { cwd: process.cwd() });
		expect(r.exitCode).toBe(0);
		expect(r.output).toContain("hello");
		expect(r.timedOut).toBe(false);
	}, 10000);

	it("非零退出码被捕获", async () => {
		const r = await runCommand('node -e "process.exit(2)"', { cwd: process.cwd() });
		expect(r.exitCode).toBe(2);
	}, 10000);

	it("超时杀进程", async () => {
		const r = await runCommand('node -e "setTimeout(()=>{}, 10000)"', {
			cwd: process.cwd(),
			timeoutSec: 1,
		});
		expect(r.timedOut).toBe(true);
	}, 5000);

	it("AbortSignal 触发杀进程", async () => {
		const ctrl = new AbortController();
		const p = runCommand('node -e "setTimeout(()=>{}, 10000)"', {
			cwd: process.cwd(),
			signal: ctrl.signal,
		});
		setTimeout(() => ctrl.abort(), 50);
		const r = await p;
		expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
	}, 5000);

	it("输出被截到 maxOutputChars", async () => {
		const r = await runCommand(
			'node -e "console.log(\\"x\\".repeat(1000))"',
			{ cwd: process.cwd(), maxOutputChars: 100 },
		);
		expect(r.output.length).toBeLessThanOrEqual(300); // 100 + truncation marker
	}, 10000);

	it("默认常量正确", () => {
		expect(DEFAULT_TIMEOUT_SEC).toBe(60);
		expect(DEFAULT_MAX_OUTPUT_CHARS).toBe(32000);
	});
});
