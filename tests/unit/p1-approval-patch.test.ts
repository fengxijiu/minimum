import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalManager } from "../../src/approval/ApprovalManager.js";
import { ApplyPatchTool } from "../../src/tools/filesystem/ApplyPatchTool.js";

// ───────────────────────── P1-2: three-tier approval ──────────────────────────

describe("ApprovalManager — three-tier modes", () => {
	const mkReq = (tool: string, args: Record<string, any> = {}) => ({
		id: "t1",
		tool,
		args,
		risk: "medium" as const,
		description: "",
		timestamp: 0,
	});

	it("read-only blocks writes, allows reads", async () => {
		const mgr = new ApprovalManager({ mode: "read-only" });
		const writeReq = await mgr.requestApproval(
			"write_file",
			{ path: "a.ts" },
			"",
		);
		const readReq = await mgr.requestApproval(
			"read_file",
			{ path: "a.ts" },
			"",
		);
		expect((await mgr.checkApproval(writeReq)).approved).toBe(false);
		expect((await mgr.checkApproval(readReq)).approved).toBe(true);
	});

	it("auto-edit allows file edits, blocks shell", async () => {
		const mgr = new ApprovalManager({ mode: "auto-edit" });
		const editReq = await mgr.requestApproval("edit_file", {}, "");
		const patchReq = await mgr.requestApproval("apply_patch", {}, "");
		const shellReq = await mgr.requestApproval(
			"exec_shell",
			{ command: "ls" },
			"",
		);
		expect((await mgr.checkApproval(editReq)).approved).toBe(true);
		expect((await mgr.checkApproval(patchReq)).approved).toBe(true);
		expect((await mgr.checkApproval(shellReq)).approved).toBe(false);
	});

	it("full-auto approves everything including shell", async () => {
		const mgr = new ApprovalManager({ mode: "full-auto" });
		const shellReq = await mgr.requestApproval(
			"exec_shell",
			{ command: "rm -rf /" },
			"",
		);
		expect((await mgr.checkApproval(shellReq)).approved).toBe(true);
	});

	it("suggest auto-approves low-risk tools", async () => {
		const mgr = new ApprovalManager({
			mode: "suggest",
			autoApproveLowRisk: true,
		});
		const readReq = await mgr.requestApproval("read_file", {}, "");
		expect((await mgr.checkApproval(readReq)).approved).toBe(true);
	});

	it("never blocks everything", async () => {
		const mgr = new ApprovalManager({ mode: "never" });
		const readReq = await mgr.requestApproval("read_file", {}, "");
		expect((await mgr.checkApproval(readReq)).approved).toBe(false);
	});

	it("habit cache overrides mode decision", async () => {
		const mgr = new ApprovalManager({ mode: "read-only" });
		// Without habit: write_file should be blocked in read-only.
		const req = await mgr.requestApproval("write_file", {}, "");
		expect((await mgr.checkApproval(req)).approved).toBe(false);
		// Set habit to always allow write_file.
		mgr.rememberHabit("write_file", "always");
		expect((await mgr.checkApproval(req)).approved).toBe(true);
		// Clear and block.
		mgr.clearHabits();
		mgr.rememberHabit("write_file", "block");
		// Even full-auto is overridden.
		mgr.setMode("full-auto");
		expect((await mgr.checkApproval(req)).approved).toBe(false);
	});

	it("setMode / getMode round-trips", () => {
		const mgr = new ApprovalManager({ mode: "suggest" });
		mgr.setMode("auto-edit");
		expect(mgr.getMode()).toBe("auto-edit");
	});
});

// ───────────────────────── P1-4: apply_patch tool ─────────────────────────────

describe("ApplyPatchTool", () => {
	let dir: string;
	let tool: ApplyPatchTool;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-"));
		tool = new ApplyPatchTool();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const write = (name: string, content: string) =>
		fs.writeFileSync(path.join(dir, name), content, "utf-8");
	const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf-8");

	it("applies a single hunk correctly", async () => {
		write("a.ts", "const x = 1;\nconst y = 2;\n");
		const out = await tool.execute(
			{
				path: "a.ts",
				hunks: [{ search: "const x = 1;", replace: "const x = 99;" }],
			},
			{ workingDirectory: dir },
		);
		expect(out).toContain("Applied 1 hunk");
		expect(read("a.ts")).toContain("const x = 99;");
		expect(read("a.ts")).toContain("const y = 2;");
	});

	it("applies multiple hunks in order", async () => {
		write("b.ts", "a\nb\nc\n");
		await tool.execute(
			{
				path: "b.ts",
				hunks: [
					{ search: "a", replace: "A" },
					{ search: "c", replace: "C" },
				],
			},
			{ workingDirectory: dir },
		);
		expect(read("b.ts")).toBe("A\nb\nC\n");
	});

	it("errors when search text is not found", async () => {
		write("c.ts", "hello world");
		const out = await tool.execute(
			{ path: "c.ts", hunks: [{ search: "goodbye", replace: "hi" }] },
			{ workingDirectory: dir },
		);
		expect(out).toContain("Error");
		expect(out).toContain("not found");
		// File must not be modified.
		expect(read("c.ts")).toBe("hello world");
	});

	it("errors when search text is ambiguous (appears more than once)", async () => {
		write("d.ts", "foo\nfoo\n");
		const out = await tool.execute(
			{ path: "d.ts", hunks: [{ search: "foo", replace: "bar" }] },
			{ workingDirectory: dir },
		);
		expect(out).toContain("Error");
		// File must not be modified.
		expect(read("d.ts")).toBe("foo\nfoo\n");
	});

	it("errors on missing file", async () => {
		const out = await tool.execute(
			{ path: "nonexistent.ts", hunks: [{ search: "x", replace: "y" }] },
			{ workingDirectory: dir },
		);
		expect(out).toContain("Error");
	});

	it("getDefinition returns valid JSON Schema", () => {
		const def = tool.getDefinition();
		expect(def.name).toBe("apply_patch");
		expect(def.parameters?.properties?.path).toBeDefined();
		expect(def.parameters?.properties?.hunks).toBeDefined();
	});
});
