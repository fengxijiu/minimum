import { describe, expect, it } from "vitest";
import { createPlannerBridge, type CompletionClient } from "../../src/orchestration/ClientAdapters.js";
import { classifyRoutePolicy } from "../../src/orchestration/RoutePolicy.js";

describe("createPlannerBridge route policy injection", () => {
	it("injects route policy into compile and refine prompts", async () => {
		const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
		const client: CompletionClient = {
			async *streamChat(options) {
				calls.push(options);
				yield { type: "content", content: "ok" };
			},
		};
		const routePolicy = classifyRoutePolicy("audit dead code", { route: "audit_review", scale: "large" });
		const planner = createPlannerBridge(client, { routePolicy });

		await planner.compile("audit dead code", "MEM");
		await planner.refine({ epicId: "e", phases: [] }, [], "MEM");

		const compileText = calls[0]!.messages.map((m) => m.content).join("\n");
		const refineText = calls[1]!.messages.map((m) => m.content).join("\n");

		for (const text of [compileText, refineText]) {
			expect(text).toContain("# Route Policy");
			expect(text).toContain("route: audit_review");
			expect(text).toContain("scale: large");
			expect(text).toContain("reviewer: 6-10");
		}
	});
});
