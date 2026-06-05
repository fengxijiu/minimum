import { describe, expect, it } from "vitest";
import { runCommand } from "../../tui/src/commands.js";
import { createInitialState } from "../../tui/src/seed.js";

const base = createInitialState("/proj");

describe("plan and mcp commands", () => {
	it("/plan drafts routes to draft listing", () => {
		const out = runCommand("/plan drafts", base);
		expect(out).toEqual({ kind: "plan.drafts" });
	});

	it("/plan import requires an id", () => {
		const out = runCommand("/plan import", base);
		expect(out.kind).toBe("note");
		if (out.kind === "note") expect(out.tone).toBe("warn");
	});

	it("/mcp resources routes to resource listing", () => {
		const out = runCommand("/mcp resources", base);
		expect(out).toEqual({ kind: "mcp.resources" });
	});

	it("/mcp health routes to the built-in health resource", () => {
		const out = runCommand("/mcp health", base);
		expect(out).toEqual({ kind: "mcp.read", ref: "minimum://mcp_health" });
	});

	it("/mcp audit routes to the built-in audit resource", () => {
		const out = runCommand("/mcp audit", base);
		expect(out).toEqual({ kind: "mcp.read", ref: "minimum://mcp_audit" });
	});

	it("/mcp registry routes to the built-in registry resource", () => {
		const out = runCommand("/mcp registry", base);
		expect(out).toEqual({ kind: "mcp.read", ref: "minimum://mcp_registry" });
	});

	it("/mcp prompt preserves raw json args", () => {
		const out = runCommand('/mcp prompt minimum.write_task_plan_draft {"title":"Demo"}', base);
		expect(out.kind).toBe("mcp.prompt");
		if (out.kind === "mcp.prompt") {
			expect(out.name).toBe("minimum.write_task_plan_draft");
			expect(out.argsText).toBe('{"title":"Demo"}');
		}
	});
});
