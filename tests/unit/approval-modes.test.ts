import { describe, expect, it } from "vitest";
import { getAvailableApprovalModes, normalizeApprovalMode } from "../../tui/src/approval-modes.js";

describe("approval mode visibility", () => {
	it("only exposes aware in orchestrate mode", () => {
		expect(getAvailableApprovalModes("agent")).toEqual(["read-only", "auto-edit", "full-auto"]);
		expect(getAvailableApprovalModes("chat")).toEqual(["read-only", "auto-edit", "full-auto"]);
		expect(getAvailableApprovalModes("orchestrate")).toEqual([
			"read-only",
			"auto-edit",
			"aware",
			"full-auto",
		]);
	});

	it("falls back from aware when leaving orchestrate mode", () => {
		expect(normalizeApprovalMode("agent", "aware")).toBe("auto-edit");
		expect(normalizeApprovalMode("chat", "aware")).toBe("auto-edit");
		expect(normalizeApprovalMode("orchestrate", "aware")).toBe("aware");
	});
});
