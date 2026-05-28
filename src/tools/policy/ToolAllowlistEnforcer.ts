import type { Persona } from "../../personas/Persona.js";

/**
 * ToolAllowlistEnforcer — gates tool availability per persona.
 *
 * Applied at the ToolRegistry layer: only tools whose name is in
 * `persona.toolAllowlist \ persona.toolDenylist` are registered for the
 * worker. The worker never sees a denied tool in its tool-list prompt,
 * so the model cannot even attempt the call.
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
	if (!persona.toolAllowlist.includes(toolName)) {
		return {
			ok: false,
			code: "NOT_IN_ALLOWLIST",
			reason: `tool ${toolName} is not in ${persona.id} allowlist`,
		};
	}
	return { ok: true };
}

/** Filter a list of tool names down to those a persona may invoke. */
export function filterAllowedTools(
	toolNames: string[],
	persona: Persona,
): string[] {
	return toolNames.filter((name) => checkTool(name, persona).ok);
}
