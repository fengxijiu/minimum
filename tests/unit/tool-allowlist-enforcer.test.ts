import { describe, expect, it } from "vitest";
import { checkTool, filterAllowedTools } from "../../src/tools/policy/ToolAllowlistEnforcer.js";
import type { Persona } from "../../src/personas/Persona.js";

function persona(allow: string[], deny: string[] = []): Persona {
	return { id: "web_searcher", toolAllowlist: allow, toolDenylist: deny } as unknown as Persona;
}

describe("checkTool wildcard allowlist", () => {
	it("matches a trailing-* prefix entry", () => {
		const p = persona(["web_fetch", "mcp__*"]);
		expect(checkTool("mcp__onesearch__one_search", p).ok).toBe(true);
		expect(checkTool("web_fetch", p).ok).toBe(true);
	});

	it("does not match outside the prefix", () => {
		const p = persona(["mcp__onesearch__*"]);
		expect(checkTool("mcp__github__create_issue", p).ok).toBe(false);
		expect(checkTool("read_file", p).ok).toBe(false);
	});

	it("denylist still wins over a wildcard allow", () => {
		const p = persona(["mcp__*"], ["mcp__danger__wipe"]);
		const d = checkTool("mcp__danger__wipe", p);
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.code).toBe("IN_DENYLIST");
	});

	it("filterAllowedTools honors the wildcard", () => {
		const p = persona(["web_fetch", "mcp__onesearch__*"]);
		expect(filterAllowedTools(["web_fetch", "mcp__onesearch__one_search", "read_file"], p))
			.toEqual(["web_fetch", "mcp__onesearch__one_search"]);
	});
});
