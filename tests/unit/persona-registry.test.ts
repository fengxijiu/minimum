import { describe, expect, it } from "vitest";
import { getPersona } from "../../src/personas/PersonaRegistry.js";
import { checkTool } from "../../src/tools/policy/ToolAllowlistEnforcer.js";

describe("web_searcher persona", () => {
	const p = getPersona("web_searcher");

	it("is a read-only worker producing task_report", () => {
		expect(p.kind).toBe("worker");
		expect(p.pathPolicy.canWrite).toBe(false);
		expect(p.pathPolicy.alwaysAllowedGlobs).toEqual([]);
		expect(p.outputSchema).toBe("task_report");
	});

	it("may call web_fetch and any MCP tool, but not write/exec tools", () => {
		expect(checkTool("web_fetch", p).ok).toBe(true);
		expect(checkTool("mcp__onesearch__one_search", p).ok).toBe(true);
		expect(checkTool("write_file", p).ok).toBe(false);
		expect(checkTool("edit_file", p).ok).toBe(false);
		expect(checkTool("apply_patch", p).ok).toBe(false);
		expect(checkTool("exec_shell", p).ok).toBe(false);
	});

	it("has a non-empty role prompt", () => {
		expect(p.systemPrompt.length).toBeGreaterThan(50);
	});
});
