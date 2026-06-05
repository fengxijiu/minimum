import type { Persona } from "../../personas/Persona.js";

/**
 * ToolAllowlistEnforcer — gates tool availability per persona.
 *
 * Applied at the ToolRegistry layer: only tools whose name is in
 * `persona.toolAllowlist \ persona.toolDenylist` are registered for the
 * worker. The worker never sees a denied tool in its tool-list prompt,
 * so the model cannot even attempt the call.
 *
 * Allowlist entries may use a trailing `*` wildcard to match a name prefix,
 * e.g. `"mcp__*"` allows all MCP tools regardless of server name. The denylist
 * always takes precedence over a wildcard allow.
 */

export type ToolDecision =
	| { ok: true }
	| { ok: false; reason: string; code: ToolDenyCode };

export type ToolDenyCode = "NOT_IN_ALLOWLIST" | "IN_DENYLIST";

export function checkTool(toolName: string, persona: Persona): ToolDecision {
	if (persona.toolDenylist.includes(toolName)) {
		return {
			ok: false,
			code: "IN_DENYLIST",
			reason: `tool ${toolName} is in ${persona.id} denylist`,
		};
	}
	if (!allowlistMatches(toolName, persona.toolAllowlist)) {
		return {
			ok: false,
			code: "NOT_IN_ALLOWLIST",
			reason: `tool ${toolName} is not in ${persona.id} allowlist`,
		};
	}
	return { ok: true };
}

/**
 * An allowlist entry matches a tool name if it is an exact match, or if it ends
 * in "*" and the tool name starts with the entry's prefix. The wildcard exists
 * so a persona can allow a family of MCP tools (mcp__<server>__*) whose exact
 * names depend on user MCP config.
 */
function allowlistMatches(toolName: string, allowlist: string[]): boolean {
	for (const entry of allowlist) {
		if (entry.endsWith("*")) {
			if (toolName.startsWith(entry.slice(0, -1))) return true;
		} else if (entry === toolName) {
			return true;
		}
	}
	return false;
}

/** Filter a list of tool names down to those a persona may invoke. */
export function filterAllowedTools(
	toolNames: string[],
	persona: Persona,
): string[] {
	return toolNames.filter((name) => checkTool(name, persona).ok);
}
