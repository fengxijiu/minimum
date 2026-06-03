import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/memory/MemoryStore.js";

describe("MemoryStore paths", () => {
	let originalCwd: string;
	let tempCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-memory-store-"));
		process.chdir(tempCwd);
	});
	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempCwd, { recursive: true, force: true });
	});

	it("expands tilde base paths instead of creating cwd-relative tilde directories", async () => {
		const store = new MemoryStore({ basePath: "~/.minimum/memory" });
		await store.initialize();

		const cwdTilde = path.join(tempCwd, "~");
		expect(fs.existsSync(path.join(cwdTilde, ".minimum"))).toBe(false);
		expect(fs.existsSync(path.join(os.homedir(), ".minimum", "memory"))).toBe(true);
	});
});
