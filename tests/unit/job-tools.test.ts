import { describe, expect, it } from "vitest";
import type { ApprovalManager } from "../../src/approval/ApprovalManager.js";
import type {
	ApprovalRequest,
	ApprovalResponse,
} from "../../src/approval/types.js";
import { JobOutputTool } from "../../src/tools/shell/JobOutputTool.js";
import { JobRegistry } from "../../src/tools/shell/JobRegistry.js";
import { ListJobsTool } from "../../src/tools/shell/ListJobsTool.js";
import { RunBackgroundTool } from "../../src/tools/shell/RunBackgroundTool.js";
import { StopJobTool } from "../../src/tools/shell/StopJobTool.js";
import { WaitForJobTool } from "../../src/tools/shell/WaitForJobTool.js";

function makeAutoApprover(): ApprovalManager {
	return {
		async requestApproval(
			tool: string,
			args: Record<string, any>,
			description: string,
		): Promise<ApprovalRequest> {
			return {
				id: "test",
				tool,
				args,
				risk: "medium",
				description,
				timestamp: Date.now(),
			};
		},
		async checkApproval(_req: ApprovalRequest): Promise<ApprovalResponse> {
			return { approved: true, reason: "test" };
		},
	} as unknown as ApprovalManager;
}

describe("Job tools (shared JobRegistry)", () => {
	it("run_background → list_jobs → job_output → stop_job 全流程", async () => {
		const jobs = new JobRegistry();
		const run = new RunBackgroundTool({
			jobs,
			rootDir: process.cwd(),
			approvalManager: makeAutoApprover(),
		});
		const list = new ListJobsTool({ jobs });
		const out = new JobOutputTool({ jobs });
		const stop = new StopJobTool({ jobs });
		const started = await run.execute({
			command:
				'node -e "console.log(\\"started\\"); setInterval(()=>{}, 1000)"',
			waitSec: 2,
		});
		expect(started).toMatch(/job \d+/);
		const id = jobs.list()[0]!.id;
		const all = await list.execute({});
		expect(all).toMatch(/\d/);
		const tail = await out.execute({ jobId: id });
		expect(tail).toContain("started");
		const stopped = await stop.execute({ jobId: id });
		expect(stopped).toMatch(/stopped/i);
	}, 10000);

	it("wait_for_job 等待 exit", async () => {
		const jobs = new JobRegistry();
		const run = new RunBackgroundTool({
			jobs,
			rootDir: process.cwd(),
			approvalManager: makeAutoApprover(),
		});
		const wait = new WaitForJobTool({ jobs });
		await run.execute({
			command: 'node -e "console.log(\\"done\\")"',
			waitSec: 1,
		});
		const id = jobs.list()[0]!.id;
		const res = await wait.execute({ jobId: id, timeoutMs: 3000 });
		const parsed = JSON.parse(res);
		expect(parsed.exited).toBe(true);
		expect(parsed.exitCode).toBe(0);
	}, 8000);

	it("job_output: not found 时返回提示", async () => {
		const jobs = new JobRegistry();
		const out = new JobOutputTool({ jobs });
		const r = await out.execute({ jobId: 99999 });
		expect(r).toMatch(/not found|list_jobs/);
	});

	it("list_jobs 空 → '(no background jobs)'", async () => {
		const jobs = new JobRegistry();
		const list = new ListJobsTool({ jobs });
		const r = await list.execute({});
		expect(r).toMatch(/no background jobs/i);
	});

	it("getDefinition 暴露正确的 name", () => {
		const jobs = new JobRegistry();
		expect(
			new RunBackgroundTool({ jobs, rootDir: "/" }).getDefinition().name,
		).toBe("run_background");
		expect(new JobOutputTool({ jobs }).getDefinition().name).toBe("job_output");
		expect(new WaitForJobTool({ jobs }).getDefinition().name).toBe(
			"wait_for_job",
		);
		expect(new StopJobTool({ jobs }).getDefinition().name).toBe("stop_job");
		expect(new ListJobsTool({ jobs }).getDefinition().name).toBe("list_jobs");
	});

	it("RunBackground 无 approvalManager + 非 allowlisted → 错误", async () => {
		const jobs = new JobRegistry();
		const run = new RunBackgroundTool({ jobs, rootDir: process.cwd() });
		const out = await run.execute({
			command: 'node -e "console.log(\\"hi\\")"',
		});
		expect(out).toMatch(/not allowlisted|no approval manager/i);
	});
});
