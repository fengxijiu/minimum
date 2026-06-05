import { describe, expect, it } from "vitest";
import {
	STAGE_ORDER,
	stageDisplay,
	stageLabel,
	stageName,
} from "../../src/orchestration/index.js";

describe("StageDisplay", () => {
	it("maps every internal phase code to its short name", () => {
		expect(stageName("W0")).toBe("Plan");
		expect(stageName("W1")).toBe("Scan");
		expect(stageName("W0.5")).toBe("Refine");
		expect(stageName("W2/3")).toBe("Build");
		expect(stageName("W3.5")).toBe("Accept");
		expect(stageName("W4")).toBe("Finalize");
	});

	it("gives every stage a non-empty description", () => {
		for (const code of STAGE_ORDER) {
			expect(stageDisplay(code).description.length).toBeGreaterThan(0);
		}
	});

	it("orders stages Plan -> Scan -> Refine -> Build -> Accept -> Finalize", () => {
		expect(STAGE_ORDER.map((code) => stageName(code))).toEqual([
			"Plan",
			"Scan",
			"Refine",
			"Build",
			"Accept",
			"Finalize",
		]);
	});

	it("falls back to a generic name for an unknown phase", () => {
		expect(stageName("W9")).toBe("Stage");
		expect(stageDisplay("W9")).toEqual({ name: "Stage", description: "" });
	});

	it("composes retry/repair labels from the short name", () => {
		expect(stageLabel("W0.5", " retry")).toBe("Refine retry");
		expect(stageLabel("W2/3", " repair 1")).toBe("Build repair 1");
		expect(stageLabel("W1")).toBe("Scan");
	});
});
