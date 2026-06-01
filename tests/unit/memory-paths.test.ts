import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	getGlobalMemoryRoot,
	getMemoryFile,
	getMemoryIndexPath,
	getProjectMemoryRoot,
	globalMemoryLayer,
	projectMemoryLayer,
} from "../../src/memory/single/MemoryPaths.js";

describe("MemoryPaths", () => {
	it("normalizes Linux project memory paths", () => {
		expect(getProjectMemoryRoot("/workspace//minimum/")).toBe(
			"/workspace/minimum/.minimum/memory",
		);
		expect(getMemoryFile(projectMemoryLayer("/workspace/minimum"), "style guide")).toBe(
			"/workspace/minimum/.minimum/memory/style_guide.md",
		);
		expect(getMemoryIndexPath(projectMemoryLayer("/workspace/minimum"))).toBe(
			"/workspace/minimum/.minimum/memory/index.json",
		);
	});

	it("normalizes macOS project memory paths", () => {
		expect(getProjectMemoryRoot("/Users/alice//repo/")).toBe(
			"/Users/alice/repo/.minimum/memory",
		);
		expect(getGlobalMemoryRoot("/Users/alice/")).toBe(
			"/Users/alice/.minimum/memory",
		);
	});

	it("normalizes Windows project memory paths independent of host OS", () => {
		const root = "C:\\Users\\alice\\repo\\";
		expect(getProjectMemoryRoot(root)).toBe(
			path.win32.join("C:\\Users\\alice\\repo", ".minimum", "memory"),
		);
		expect(getMemoryFile(projectMemoryLayer(root), "docs\\api key")).toBe(
			path.win32.join(
				"C:\\Users\\alice\\repo",
				".minimum",
				"memory",
				"docs-api_key.md",
			),
		);
		expect(getMemoryIndexPath(globalMemoryLayer("C:\\Users\\alice\\"))).toBe(
			path.win32.join("C:\\Users\\alice", ".minimum", "memory", "index.json"),
		);
	});
});
