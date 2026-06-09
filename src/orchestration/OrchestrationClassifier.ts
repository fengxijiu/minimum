import { classifyRoutePolicy } from "./RoutePolicy.js";

export type OrchestrationMode =
	| "single_agent"
	| "scan_only"
	| "direct_edit"
	| "full_pipeline";

export function classifyOrchestrationMode(userRequest: string): OrchestrationMode {
	const policy = classifyRoutePolicy(userRequest);
	if (policy.route === "scan_only") return "scan_only";
	if (policy.route === "direct_edit") return "direct_edit";
	return "full_pipeline";
}
