import { describe, expect, it } from "vitest";
import { ExecShellTool } from "../../src/tools/shell/ExecShellTool.js";
import type { ApprovalManager } from "../../src/approval/ApprovalManager.js";
import type { ApprovalRequest, ApprovalResponse } from "../../src/approval/types.js";

/** Test gate that auto-approves every request. */
function makeAutoApprover(): ApprovalManager {
	return {
		async requestApproval(tool: string, args: Record<string, any>, description: string): Promise<ApprovalRequest> {
			return {
				id: "test-approval",
				tool,
				args,
				risk: "medium",
				description,
				timestamp: Date.now(),
			};
		},
		async checkApproval(_req: ApprovalRequest): Promise<ApprovalResponse> {
			return { approved: true, reason: "test: auto-approved" };
		},
	} as unknown as ApprovalManager;
}

/** Test gate that auto-rejects every request. */
function makeAutoRejector(): ApprovalManager {
	return {
		async requestApproval(tool: string, args: Record<string, any>, description: string): Promise<ApprovalRequest> {
			return {
				id: "test-approval",
				tool,
				args,
				risk: "high",
				description,
				timestamp: Date.now(),
			};
		},
		async checkApproval(_req: ApprovalRequest): Promise<ApprovalResponse> {
			return { approved: false, reason: "test: auto-rejected" };
		},
	} as unknown as ApprovalManager;
}

describe("ExecShellTool (rewritten with runCommand)", () => {
	it("allowlisted 命令直接通过(无 approvalManager 时)", async () => {
		const tool = new ExecShellTool();
		const out = await tool.execute({ command: "node --version" });
		expect(out).toMatch(/v\d+/);
	}, 10000);

	it("非允许列表命令 + 无 approvalManager → 返回错误", async () => {
		const tool = new ExecShellTool();
		// `node -e "..."` is NOT in BUILTIN_ALLOWLIST
		const out = await tool.execute({ command: 'node -e "console.log(\\"hi\\")"' });
		expect(out).toMatch(/not allowlisted|no approval manager/i);
	});

	it("非允许列表 + 自动批准 manager → 命令执行", async () => {
		const tool = new ExecShellTool({ approvalManager: makeAutoApprover() });
		const out = await tool.execute({ command: 'node -e "console.log(\\"hi\\")"' });
		expect(out).toContain("hi");
	}, 10000);

	it("非允许列表 + 自动拒绝 manager → 返回拒绝错误", async () => {
		const tool = new ExecShellTool({ approvalManager: makeAutoRejector() });
		const out = await tool.execute({ command: 'node -e "process.exit(0)"' });
		expect(out).toMatch(/denied/i);
	});

	it("非零退出码体现在结果里", async () => {
		const tool = new ExecShellTool({ approvalManager: makeAutoApprover() });
		const out = await tool.execute({ command: 'node -e "process.exit(3)"' });
		expect(out).toMatch(/exit 3/);
	}, 10000);

	it("超时被报告", async () => {
		const tool = new ExecShellTool({ approvalManager: makeAutoApprover() });
		const out = await tool.execute({
			command: 'node -e "setTimeout(()=>{}, 10000)"',
			timeoutSec: 1,
		});
		expect(out).toMatch(/timeout|killed after timeout/i);
	}, 5000);

	it("getDefinition 暴露 command/timeoutSec/cwd 参数", () => {
		const tool = new ExecShellTool();
		const def = tool.getDefinition();
		expect(def.parameters.properties.command).toBeDefined();
		expect(def.parameters.properties.timeoutSec).toBeDefined();
		expect(def.parameters.required).toContain("command");
	});

	it("空命令返回错误", async () => {
		const tool = new ExecShellTool();
		const out = await tool.execute({ command: "" });
		expect(out).toMatch(/empty/i);
	});

	it("extraAllowed 允许额外命令", async () => {
		// Tool constructor accepts extraAllowed; test it works
		const tool = new ExecShellTool({ extraAllowed: ["node -e"] });
		const out = await tool.execute({ command: 'node -e "console.log(\\"extra\\")"' });
		expect(out).toContain("extra");
	}, 10000);
});
