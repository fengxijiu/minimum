import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractCandidates } from "../../src/memory/single/MemoryExtractor.js";

describe("MemoryExtractor", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-extractor-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("extracts a global candidate for Chinese response preference", async () => {
		const candidates = await extractCandidates(
			[
				{ role: "system", content: "memory prelude: canonical memory" },
				{
					role: "user",
					content: "以后回答都用中文",
					reasoning_content: "不要读取这段 reasoning",
				},
			],
			{ projectRoot: dir, sourceTask: "turn" },
		);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]!.layer).toBe("global");
		expect(candidates[0]!.category).toBe("user_preference");
		expect(candidates[0]!.content).toContain("以后回答都用中文");
		expect(stagedFiles()).toHaveLength(1);
	});

	it("extracts a project candidate for a project test command", async () => {
		const candidates = await extractCandidates(
			[{ role: "user", content: "本项目测试命令是 npm test" }],
			{ projectRoot: dir, sourceTask: "turn" },
		);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]!.layer).toBe("project");
		expect(candidates[0]!.category).toBe("command");
		expect(candidates[0]!.content).toContain("npm test");
		expect(stagedText()).toContain("layer: project");
	});

	it("filters token-like secrets and does not write staging files", async () => {
		const candidates = await extractCandidates(
			[
				{
					role: "user",
					content: "token=abc123456789012345678901234567890，请记住",
				},
			],
			{ projectRoot: dir, sourceTask: "turn" },
		);

		expect(candidates).toEqual([]);
		expect(stagedFiles()).toEqual([]);
	});

	function stagedFiles(): string[] {
		const staging = path.join(dir, ".minimum", "_staging");
		return fs.existsSync(staging) ? fs.readdirSync(staging) : [];
	}

	function stagedText(): string {
		const staging = path.join(dir, ".minimum", "_staging");
		return fs.readFileSync(
			path.join(staging, fs.readdirSync(staging)[0]!),
			"utf-8",
		);
	}
});
