import { describe, expect, it } from "vitest";
import { JobRegistry } from "../../src/tools/shell/JobRegistry.js";

describe("JobRegistry", () => {
	it("启动短命进程并捕获 exit code", async () => {
		const jobs = new JobRegistry();
		const r = await jobs.start('node -e "console.log(\\"ok\\")"', {
			cwd: process.cwd(),
			waitSec: 2,
		});
		expect(r.jobId).toBeGreaterThan(0);
		expect(r.preview).toContain("ok");
		await jobs.waitForJob(r.jobId, { timeoutMs: 3000 });
		const rec = jobs.list().find(j => j.id === r.jobId);
		expect(rec?.running).toBe(false);
		expect(rec?.exitCode).toBe(0);
	}, 8000);

	it("拒绝带 shell 操作符的命令", async () => {
		const jobs = new JobRegistry();
		await expect(jobs.start("a | b", { cwd: process.cwd() })).rejects.toThrow(/shell operator/);
	});

	it("拒绝空命令", async () => {
		const jobs = new JobRegistry();
		await expect(jobs.start("", { cwd: process.cwd() })).rejects.toThrow(/empty command/);
	});

	it("list 返回 snapshot", async () => {
		const jobs = new JobRegistry();
		await jobs.start('node -e "console.log(1)"', { cwd: process.cwd(), waitSec: 2 });
		expect(jobs.list().length).toBeGreaterThanOrEqual(1);
	}, 5000);

	it("stop 后 record.running === false", async () => {
		const jobs = new JobRegistry();
		const r = await jobs.start('node -e "setTimeout(()=>{}, 30000)"', {
			cwd: process.cwd(),
			waitSec: 1,
		});
		const stopped = await jobs.stop(r.jobId, { graceMs: 100 });
		expect(stopped?.running).toBe(false);
	}, 15000);

	it("ready signal 短路 wait", async () => {
		const jobs = new JobRegistry();
		const r = await jobs.start(
			'node -e "console.log(\\"compiled successfully\\"); setInterval(()=>{}, 1000)"',
			{ cwd: process.cwd(), waitSec: 10 },
		);
		expect(r.readyMatched).toBe(true);
		expect(r.stillRunning).toBe(true);
		await jobs.stop(r.jobId);
	}, 8000);

	it("runningCount 准确", async () => {
		const jobs = new JobRegistry();
		expect(jobs.runningCount()).toBe(0);
		const r = await jobs.start(
			'node -e "setInterval(()=>{}, 1000)"',
			{ cwd: process.cwd(), waitSec: 1 },
		);
		expect(jobs.runningCount()).toBe(1);
		await jobs.stop(r.jobId);
		expect(jobs.runningCount()).toBe(0);
	}, 5000);
});
