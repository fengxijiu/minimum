import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EditFileTool } from "../../src/tools/filesystem/EditFileTool.js";
import { ReadFileTool } from "../../src/tools/filesystem/ReadFileTool.js";
import { ReadTracker } from "../../src/loop/ReadTracker.js";

describe("EditFileTool + ReadTracker", () => {
	let dir: string;
	let file: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "minimum-edit-"));
		file = path.join(dir, "a.txt");
		await fs.writeFile(file, "hello world", "utf-8");
	});

	it("未注入 tracker 时旧行为保持(可直接编辑)", async () => {
		const edit = new EditFileTool();
		const out = await edit.execute({
			path: file,
			edits: [{ search: "world", replace: "claude" }],
		});
		expect(out).toContain("edited successfully");
		expect(await fs.readFile(file, "utf-8")).toBe("hello claude");
	});

	it("注入 tracker 但未先读则拒绝编辑", async () => {
		const tracker = new ReadTracker();
		const edit = new EditFileTool({ readTracker: tracker });
		const out = await edit.execute({
			path: file,
			edits: [{ search: "world", replace: "x" }],
		});
		expect(out).toMatch(/not been read yet/i);
		expect(await fs.readFile(file, "utf-8")).toBe("hello world");
	});

	it("先 read_file 后 edit 才放行", async () => {
		const tracker = new ReadTracker();
		const read = new ReadFileTool({ readTracker: tracker });
		const edit = new EditFileTool({ readTracker: tracker });
		await read.execute({ path: file });
		const out = await edit.execute({
			path: file,
			edits: [{ search: "world", replace: "claude" }],
		});
		expect(out).toContain("edited successfully");
	});
});
