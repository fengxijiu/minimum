import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGitStore } from "../../src/git/AgentGitStore.js";
import { WorktreeIsolator } from "../../src/git/WorktreeIsolator.js";

describe("integrated-ref primitives", () => {
	let dir: string;
	let store: AgentGitStore;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-"));
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "init"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
			cwd: dir,
			stdio: "ignore",
		});
		store = await AgentGitStore.resolve(dir);
	});

	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* win */
		}
	});

	it("overlayCommit stacks a task's changed files onto a base commit", async () => {
		const head = (await store.readRef("HEAD"))!;
		const taskCommit = await store.commitTree([{ relativePath: "src/a.ts", content: "A" }], "task", {
			parent: head,
		});
		const result = await store.overlayCommit(head, taskCommit, head, "integrate");
		expect(await store.readFileAtCommit(result.sha, "src/a.ts")).toBe("A");
		expect(result.conflictingFiles).toEqual([]);
	});

	it("overlayCommit preserves base files not touched by the task", async () => {
		const head = (await store.readRef("HEAD"))!;
		const base = await store.commitTree([{ relativePath: "keep.ts", content: "original" }], "base", {
			parent: head,
		});
		// Simulate a real worktree commit: inherits keep.ts and adds new.ts
		const taskCommit = await store.commitTree(
			[
				{ relativePath: "keep.ts", content: "original" },
				{ relativePath: "new.ts", content: "new" },
			],
			"task",
			{ parent: base },
		);
		const result = await store.overlayCommit(base, taskCommit, base, "integrate");
		expect(await store.readFileAtCommit(result.sha, "keep.ts")).toBe("original");
		expect(await store.readFileAtCommit(result.sha, "new.ts")).toBe("new");
		expect(result.conflictingFiles).toEqual([]);
	});

	it("overlayCommit handles file deletions", async () => {
		const head = (await store.readRef("HEAD"))!;
		const base = await store.commitTree([{ relativePath: "remove-me.ts", content: "bye" }], "base", {
			parent: head,
		});
		const taskCommit = await store.commitTree([{ relativePath: "remove-me.ts", content: null }], "task", {
			parent: base,
		});
		const result = await store.overlayCommit(base, taskCommit, base, "integrate");
		expect(await store.readFileAtCommit(result.sha, "remove-me.ts")).toBeNull();
		expect(result.conflictingFiles).toEqual([]);
	});

	it("compareAndSwapRef only advances when the expected old value matches", async () => {
		const head = (await store.readRef("HEAD"))!;
		const next = await store.commitTree([{ relativePath: "x", content: "1" }], "n", { parent: head });
		await store.setRef("refs/minimum/run/integrated", head);
		expect(await store.compareAndSwapRef("refs/minimum/run/integrated", head, next)).toBe(true);
		expect(await store.compareAndSwapRef("refs/minimum/run/integrated", head, next)).toBe(false);
		expect(await store.readRef("refs/minimum/run/integrated")).toBe(next);
	});

	it("compareAndSwapRef creates a new ref when oldSha is empty string", async () => {
		const head = (await store.readRef("HEAD"))!;
		const ref = "refs/minimum/run/new-ref";
		expect(await store.readRef(ref)).toBeNull();
		expect(await store.compareAndSwapRef(ref, "", head)).toBe(true);
		expect(await store.readRef(ref)).toBe(head);
	});

	it("overlayCommit skips files modified on the integrated tree by another task", async () => {
		const head = (await store.readRef("HEAD"))!;
		// Both tasks fork from the same base
		const base = await store.commitTree(
			[
				{ relativePath: "shared.ts", content: "original" },
				{ relativePath: "keep.ts", content: "keep" },
			],
			"base",
			{ parent: head },
		);

		// Task A modifies shared.ts + adds unique-a.ts
		const taskA = await store.commitTree(
			[
				{ relativePath: "shared.ts", content: "from-A" },
				{ relativePath: "keep.ts", content: "keep" },
				{ relativePath: "unique-a.ts", content: "A" },
			],
			"task-a",
			{ parent: base },
		);

		// Apply task A's overlay → integrated advances
		const overlayA = await store.overlayCommit(base, taskA, base, "integrate-a");
		expect(overlayA.conflictingFiles).toEqual([]);

		// Task B modifies shared.ts + adds unique-b.ts (also forked from base)
		const taskB = await store.commitTree(
			[
				{ relativePath: "shared.ts", content: "from-B" },
				{ relativePath: "keep.ts", content: "keep" },
				{ relativePath: "unique-b.ts", content: "B" },
			],
			"task-b",
			{ parent: base },
		);

		// Overlay B onto the integrated tree (which now has A's changes)
		const overlayB = await store.overlayCommit(overlayA.sha, taskB, base, "integrate-b");
		// shared.ts was modified by A → conflict for B → skipped
		expect(overlayB.conflictingFiles).toEqual(["shared.ts"]);
		// unique-b.ts was overlaid successfully
		expect(await store.readFileAtCommit(overlayB.sha, "unique-b.ts")).toBe("B");
		// shared.ts retains A's version (B's change was skipped)
		expect(await store.readFileAtCommit(overlayB.sha, "shared.ts")).toBe("from-A");
		// keep.ts is preserved
		expect(await store.readFileAtCommit(overlayB.sha, "keep.ts")).toBe("keep");
	});

	it("blobOidAtCommit returns the blob sha for a file at a given commit", async () => {
		const head = (await store.readRef("HEAD"))!;
		const commit = await store.commitTree([{ relativePath: "hello.txt", content: "hello" }], "add", {
			parent: head,
		});
		const oid = await store.blobOidAtCommit(commit, "hello.txt");
		expect(oid).not.toBeNull();
		const content = await store.readBlob(oid!);
		expect(content).toBe("hello");
	});

	it("blobOidAtCommit returns null for a missing file", async () => {
		const head = (await store.readRef("HEAD"))!;
		const oid = await store.blobOidAtCommit(head, "nonexistent.ts");
		expect(oid).toBeNull();
	});
});

describe("applyCommitFilesChecked — conflict-aware apply-back", () => {
	let dir: string;
	let store: AgentGitStore;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-checked-"));
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "init"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
			cwd: dir,
			stdio: "ignore",
		});
		store = await AgentGitStore.resolve(dir);
	});

	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* win */
		}
	});

	it("applies cleanly when main tree matches baseSha", async () => {
		const head = (await store.readRef("HEAD"))!;
		// Base commit has "original" content
		const base = await store.commitTree(
			[{ relativePath: "a.ts", content: "original" }],
			"base",
			{ parent: head },
		);
		// Task commit changes a.ts to "updated"
		const taskCommit = await store.commitTree(
			[{ relativePath: "a.ts", content: "updated" }],
			"task",
			{ parent: base },
		);

		// Main tree still has "original" (matches base)
		const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-"));
		fs.writeFileSync(path.join(targetDir, "a.ts"), "original", "utf-8");

		const result = await store.applyCommitFilesChecked(taskCommit, base, targetDir);
		expect(result.applied).toEqual(["a.ts"]);
		expect(result.conflicts).toEqual([]);
		expect(fs.readFileSync(path.join(targetDir, "a.ts"), "utf-8")).toBe("updated");

		fs.rmSync(targetDir, { recursive: true, force: true });
	});

	it("detects conflict when main tree diverged from baseSha", async () => {
		const head = (await store.readRef("HEAD"))!;
		const base = await store.commitTree(
			[{ relativePath: "a.ts", content: "original" }],
			"base",
			{ parent: head },
		);
		const taskCommit = await store.commitTree(
			[{ relativePath: "a.ts", content: "task-version" }],
			"task",
			{ parent: base },
		);

		// Main tree has been modified by someone else since base
		const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-"));
		fs.writeFileSync(path.join(targetDir, "a.ts"), "someone-else-was-here", "utf-8");

		const result = await store.applyCommitFilesChecked(taskCommit, base, targetDir);
		expect(result.conflicts).toEqual(["a.ts"]);
		expect(result.applied).toEqual([]);
		// Main tree left untouched — the conflicting content is preserved
		expect(fs.readFileSync(path.join(targetDir, "a.ts"), "utf-8")).toBe("someone-else-was-here");

		fs.rmSync(targetDir, { recursive: true, force: true });
	});

	it("applies new files (not in base) without conflict", async () => {
		const head = (await store.readRef("HEAD"))!;
		const base = await store.commitTree([], "base", { parent: head });
		// Task adds a brand-new file
		const taskCommit = await store.commitTree(
			[{ relativePath: "new.ts", content: "brand new" }],
			"task",
			{ parent: base },
		);

		const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-"));
		const result = await store.applyCommitFilesChecked(taskCommit, base, targetDir);
		expect(result.applied).toEqual(["new.ts"]);
		expect(result.conflicts).toEqual([]);
		expect(fs.readFileSync(path.join(targetDir, "new.ts"), "utf-8")).toBe("brand new");

		fs.rmSync(targetDir, { recursive: true, force: true });
	});

	it("applies clean files and reports conflicts in the same call", async () => {
		const head = (await store.readRef("HEAD"))!;
		const base = await store.commitTree(
			[
				{ relativePath: "clean.ts", content: "base-clean" },
				{ relativePath: "dirty.ts", content: "base-dirty" },
			],
			"base",
			{ parent: head },
		);
		const taskCommit = await store.commitTree(
			[
				{ relativePath: "clean.ts", content: "task-clean" },
				{ relativePath: "dirty.ts", content: "task-dirty" },
			],
			"task",
			{ parent: base },
		);

		const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "target-"));
		// clean.ts matches base → no conflict; dirty.ts diverged → conflict
		fs.writeFileSync(path.join(targetDir, "clean.ts"), "base-clean", "utf-8");
		fs.writeFileSync(path.join(targetDir, "dirty.ts"), "diverged", "utf-8");

		const result = await store.applyCommitFilesChecked(taskCommit, base, targetDir);
		expect(result.applied).toContain("clean.ts");
		expect(result.conflicts).toEqual(["dirty.ts"]);
		expect(fs.readFileSync(path.join(targetDir, "clean.ts"), "utf-8")).toBe("task-clean");
		expect(fs.readFileSync(path.join(targetDir, "dirty.ts"), "utf-8")).toBe("diverged");

		fs.rmSync(targetDir, { recursive: true, force: true });
	});
});

describe("WorktreeIsolator.commitAndApply surfaces conflicts", () => {
	let dir: string;
	let store: AgentGitStore;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "iso-conflict-"));
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "init"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
			cwd: dir,
			stdio: "ignore",
		});
		store = await AgentGitStore.resolve(dir);
	});

	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* win */
		}
	});

	it("returns empty conflicts when apply-back is clean", async () => {
		const head = (await store.readRef("HEAD"))!;
		const isolator = new WorktreeIsolator(store);
		const wt = await isolator.create("task-clean", head);

		fs.writeFileSync(path.join(wt, "new-file.ts"), "hello", "utf-8");
		const result = await isolator.commitAndApply("task-clean", head, "add new-file");

		expect(result.sha).not.toBeNull();
		expect(result.changedFiles).toContain("new-file.ts");
		expect(result.conflicts).toEqual([]);

		await isolator.discard("task-clean");
	});

	it("returns conflict records when main tree diverged from baseSha", async () => {
		const head = (await store.readRef("HEAD"))!;
		// Create a base with a file that both tasks will touch
		const base = await store.commitTree(
			[{ relativePath: "shared.ts", content: "original" }],
			"base",
			{ parent: head },
		);

		// Write "original" to the main tree at base
		fs.writeFileSync(path.join(store.config.workTree, "shared.ts"), "original", "utf-8");

		const isolator = new WorktreeIsolator(store);

		// Task A: modifies shared.ts
		const wtA = await isolator.create("task-a", base);
		fs.writeFileSync(path.join(wtA, "shared.ts"), "from-A", "utf-8");
		const resultA = await isolator.commitAndApply("task-a", base, "task-a: modify shared");
		expect(resultA.conflicts).toEqual([]);
		// Main tree now has "from-A"
		expect(
			fs.readFileSync(path.join(store.config.workTree, "shared.ts"), "utf-8").replace(/\r\n/g, "\n"),
		).toBe("from-A");

		// Task B: also modifies shared.ts, forked from same base
		const wtB = await isolator.create("task-b", base);
		fs.writeFileSync(path.join(wtB, "shared.ts"), "from-B", "utf-8");
		const resultB = await isolator.commitAndApply("task-b", base, "task-b: modify shared");

		// Main tree has "from-A" which diverged from base ("original") → conflict
		expect(resultB.conflicts.length).toBe(1);
		expect(resultB.conflicts[0].path).toBe("shared.ts");
		expect(resultB.conflicts[0].baseSha).toBe(base);
		expect(resultB.conflicts[0].taskCommitSha).toBe(resultB.sha);

		// Main tree untouched — still has A's version
		expect(
			fs.readFileSync(path.join(store.config.workTree, "shared.ts"), "utf-8").replace(/\r\n/g, "\n"),
		).toBe("from-A");

		await isolator.discard("task-a");
		await isolator.discard("task-b");
	});
});

describe("worktree chaining: downstream sees upstream output", () => {
	let dir: string;
	let store: AgentGitStore;
	const runId = "run_chain_test";

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-e2e-"));
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "init"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
			cwd: dir,
			stdio: "ignore",
		});
		store = await AgentGitStore.resolve(dir);
	});

	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* win */
		}
	});

	it("a downstream isolated task forks from the integrated ref and sees upstream output", async () => {
		const head = (await store.readRef("HEAD"))!;
		const integratedRef = `refs/minimum/${runId}/integrated`;
		await store.setRef(integratedRef, head);

		const isolator = new WorktreeIsolator(store);

		// ── Task A: writes upstream.ts ──
		const baseA = (await store.readRef(integratedRef)) ?? head;
		const wtA = await isolator.create("task-a", baseA);
		fs.writeFileSync(path.join(wtA, "upstream.ts"), "export const X = 1;\n", "utf-8");
		const resultA = await isolator.commitAndApply("task-a", baseA, "task-a: add upstream.ts");
		await isolator.discard("task-a");

		// Advance the integrated ref (same logic as WorkerLoop)
		if (resultA?.sha) {
			for (let attempt = 0; attempt < 5; attempt++) {
				const current = (await store.readRef(integratedRef)) ?? baseA;
				const overlay = await store.overlayCommit(current, resultA.sha, baseA, "integrate(task-a)");
				if (await store.compareAndSwapRef(integratedRef, current, overlay.sha)) break;
			}
		}

		// ── Task B: forks from advanced integrated ref ──
		const baseB = (await store.readRef(integratedRef)) ?? head;
		// The integrated ref should have advanced past the initial HEAD
		expect(baseB).not.toBe(head);

		const wtB = await isolator.create("task-b", baseB);
		// Task B's worktree should contain upstream.ts written by task A
		const upstreamExists = fs.existsSync(path.join(wtB, "upstream.ts"));
		expect(upstreamExists).toBe(true);

		if (upstreamExists) {
			const content = fs.readFileSync(path.join(wtB, "upstream.ts"), "utf-8");
			expect(content.replace(/\r\n/g, "\n")).toBe("export const X = 1;\n");
		}

		await isolator.discard("task-b");
	});
});

describe("W4 master-agent 3-way merge", () => {
	let dir: string;
	let store: AgentGitStore;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "w4-merge-"));
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "init"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
			cwd: dir,
			stdio: "ignore",
		});
		store = await AgentGitStore.resolve(dir);
	});

	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* win */
		}
	});

	it("writes the master-merged content for a recorded conflict", async () => {
		const head = (await store.readRef("HEAD"))!;
		const base = await store.commitTree(
			[{ relativePath: "s.ts", content: "base" }],
			"base",
			{ parent: head },
		);
		const theirs = await store.commitTree(
			[{ relativePath: "s.ts", content: "theirs" }],
			"theirs",
			{ parent: base },
		);
		fs.writeFileSync(path.join(dir, "s.ts"), "ours", "utf-8");

		const planner = {
			resolveConflict: async () => "MERGED",
		} as unknown as import("../../src/orchestration/MiMoPipeline.js").PlannerBridge;

		const { applyMasterMergedConflicts } = await import(
			"../../src/orchestration/MiMoPipeline.js"
		);
		const result = await applyMasterMergedConflicts(
			[{ taskId: "T1", path: "s.ts", baseSha: base, taskCommitSha: theirs }],
			{ store, projectRoot: dir, planner },
		);

		expect(result[0].ok).toBe(true);
		expect(fs.readFileSync(path.join(dir, "s.ts"), "utf-8")).toBe("MERGED");
	});

	it("passes base, ours, and theirs to resolveConflict", async () => {
		const head = (await store.readRef("HEAD"))!;
		const base = await store.commitTree(
			[{ relativePath: "f.ts", content: "base-content" }],
			"base",
			{ parent: head },
		);
		const theirs = await store.commitTree(
			[{ relativePath: "f.ts", content: "theirs-content" }],
			"theirs",
			{ parent: base },
		);
		fs.writeFileSync(path.join(dir, "f.ts"), "ours-content", "utf-8");

		let capturedInput: { path: string; base: string | null; ours: string | null; theirs: string | null } | undefined;
		const planner = {
			resolveConflict: async (input: { path: string; base: string | null; ours: string | null; theirs: string | null }) => {
				capturedInput = input;
				return "RESOLVED";
			},
		} as unknown as import("../../src/orchestration/MiMoPipeline.js").PlannerBridge;

		const { applyMasterMergedConflicts } = await import(
			"../../src/orchestration/MiMoPipeline.js"
		);
		await applyMasterMergedConflicts(
			[{ taskId: "T2", path: "f.ts", baseSha: base, taskCommitSha: theirs }],
			{ store, projectRoot: dir, planner },
		);

		expect(capturedInput).toBeDefined();
		expect(capturedInput!.path).toBe("f.ts");
		expect(capturedInput!.base).toBe("base-content");
		expect(capturedInput!.ours).toBe("ours-content");
		expect(capturedInput!.theirs).toBe("theirs-content");
	});

	it("reports ok=false when resolveConflict throws", async () => {
		const head = (await store.readRef("HEAD"))!;
		const base = await store.commitTree(
			[{ relativePath: "g.ts", content: "base" }],
			"base",
			{ parent: head },
		);
		const theirs = await store.commitTree(
			[{ relativePath: "g.ts", content: "theirs" }],
			"theirs",
			{ parent: base },
		);
		fs.writeFileSync(path.join(dir, "g.ts"), "ours", "utf-8");

		const planner = {
			resolveConflict: async () => {
				throw new Error("LLM unavailable");
			},
		} as unknown as import("../../src/orchestration/MiMoPipeline.js").PlannerBridge;

		const { applyMasterMergedConflicts } = await import(
			"../../src/orchestration/MiMoPipeline.js"
		);
		const result = await applyMasterMergedConflicts(
			[{ taskId: "T3", path: "g.ts", baseSha: base, taskCommitSha: theirs }],
			{ store, projectRoot: dir, planner },
		);

		expect(result[0].ok).toBe(false);
		// File untouched on failure
		expect(fs.readFileSync(path.join(dir, "g.ts"), "utf-8")).toBe("ours");
	});
});

describe("binary-safe git primitives", () => {
	let dir: string;
	let store: AgentGitStore;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "bin-safe-"));
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "init"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
			cwd: dir,
			stdio: "ignore",
		});
		store = await AgentGitStore.resolve(dir);
	});

	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* win */
		}
	});

	it("readBlobAtCommit returns raw Buffer for a binary file", async () => {
		const head = (await store.readRef("HEAD"))!;
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe]);
		// Write binary via worktree so git stores raw bytes
		const wt = fs.mkdtempSync(path.join(os.tmpdir(), "bin-wt-"));
		execFileSync("git", ["worktree", "add", "--detach", wt, "HEAD"], { cwd: dir, stdio: "ignore" });
		fs.writeFileSync(path.join(wt, "img.bin"), png);
		const sha = await store.captureWorktreeChanges(wt, "add binary");
		execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: dir, stdio: "ignore" });

		const buf = await store.readBlobAtCommit(sha!, "img.bin");
		expect(buf).not.toBeNull();
		expect(buf!.equals(png)).toBe(true);
	});

	it("readBlobAtCommit returns null for a missing file", async () => {
		const head = (await store.readRef("HEAD"))!;
		const buf = await store.readBlobAtCommit(head, "nonexistent.bin");
		expect(buf).toBeNull();
	});

	it("hashFile returns the OID git would assign to an on-disk file", async () => {
		const tmpFile = path.join(dir, "test.txt");
		fs.writeFileSync(tmpFile, "hello world\n", "utf-8");
		const oid = await store.hashFile(tmpFile);
		expect(oid).not.toBeNull();
		// Cross-check with git hash-object directly
		const expected = execFileSync("git", ["hash-object", tmpFile], { cwd: dir, encoding: "utf-8" }).trim();
		expect(oid).toBe(expected);
	});

	it("hashFile returns null for a missing file", async () => {
		const oid = await store.hashFile(path.join(dir, "nope.txt"));
		expect(oid).toBeNull();
	});

	it("isBinaryAtCommit detects binary files (NUL byte)", async () => {
		const head = (await store.readRef("HEAD"))!;
		const wt = fs.mkdtempSync(path.join(os.tmpdir(), "bin-det-"));
		execFileSync("git", ["worktree", "add", "--detach", wt, "HEAD"], { cwd: dir, stdio: "ignore" });
		fs.writeFileSync(path.join(wt, "data.bin"), Buffer.from([0x00, 0x01, 0x02]));
		fs.writeFileSync(path.join(wt, "text.txt"), "plain text");
		const sha = await store.captureWorktreeChanges(wt, "add files");
		execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: dir, stdio: "ignore" });

		expect(await store.isBinaryAtCommit(sha!, "data.bin")).toBe(true);
		expect(await store.isBinaryAtCommit(sha!, "text.txt")).toBe(false);
	});

	it("applyCommitFilesChecked preserves binary bytes exactly", async () => {
		const head = (await store.readRef("HEAD"))!;
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe]);
		// Commit a binary file via a real worktree
		const wt = fs.mkdtempSync(path.join(os.tmpdir(), "bin-apply-"));
		execFileSync("git", ["worktree", "add", "--detach", wt, "HEAD"], { cwd: dir, stdio: "ignore" });
		fs.writeFileSync(path.join(wt, "img.bin"), png);
		const taskSha = await store.captureWorktreeChanges(wt, "add binary");
		execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: dir, stdio: "ignore" });

		const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "bin-target-"));
		const result = await store.applyCommitFilesChecked(taskSha!, head, targetDir);

		expect(result.applied).toContain("img.bin");
		expect(result.conflicts).toEqual([]);
		const written = fs.readFileSync(path.join(targetDir, "img.bin"));
		expect(written.equals(png)).toBe(true);

		fs.rmSync(targetDir, { recursive: true, force: true });
	});
});
