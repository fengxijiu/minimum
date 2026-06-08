import type { PersonaId } from "../personas/Persona.js";
import type { ExecutionDepth } from "./ExecutionBudget.js";

export type OrchestrationRoute =
	| "scan_only"
	| "direct_edit"
	| "audit_review"
	| "implementation"
	| "debug_fix"
	| "dependency_config"
	| "full_pipeline";

export type FanoutScale = "small" | "medium" | "large" | "auto";

export interface RouteHint {
	route?: string;
	scale?: string;
}

export interface CountCap {
	min: number;
	max: number;
}

export interface RoutePolicy {
	route: OrchestrationRoute;
	scale: FanoutScale;
	source: "explicit" | "auto";
	confidence: "low" | "medium" | "high";
	reasons: string[];
	taskCaps: Partial<Record<PersonaId, CountCap>>;
	personaCaps: Partial<Record<PersonaId, number>>;
	granularityCaps: {
		reviewerMaxDomains: number;
		reviewerMaxCoreFiles: number;
		executorMaxFiles: number;
		testWriterMaxAcceptance: number;
		contextPackMaxTokens: number;
	};
	executionDepthByPersona: Partial<Record<PersonaId, ExecutionDepth>>;
}

const ROUTES = new Set<OrchestrationRoute>([
	"scan_only",
	"direct_edit",
	"audit_review",
	"implementation",
	"debug_fix",
	"dependency_config",
	"full_pipeline",
]);

const SCALES = new Set<FanoutScale>(["small", "medium", "large", "auto"]);

export function normalizeRouteHint(hint?: RouteHint): { route?: OrchestrationRoute; scale?: FanoutScale } {
	const out: { route?: OrchestrationRoute; scale?: FanoutScale } = {};
	if (hint?.route !== undefined) {
		const route = hint.route.trim().toLowerCase().replace(/-/g, "_") as OrchestrationRoute;
		if (!ROUTES.has(route)) throw new Error(`unknown orchestration route: ${hint.route}`);
		out.route = route;
	}
	if (hint?.scale !== undefined) {
		const scale = hint.scale.trim().toLowerCase() as FanoutScale;
		if (!SCALES.has(scale)) throw new Error(`unknown fanout scale: ${hint.scale}`);
		out.scale = scale;
	}
	return out;
}

export function parseRouteHintFromInput(input: string): { cleanInput: string; routeHint?: RouteHint } {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const kept: string[] = [];
	const routeHint: RouteHint = {};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--route" && tokens[i + 1]) {
			routeHint.route = tokens[++i];
			continue;
		}
		if ((token === "--fanout" || token === "--scale") && tokens[i + 1]) {
			routeHint.scale = tokens[++i];
			continue;
		}
		kept.push(token);
	}
	return {
		cleanInput: kept.join(" "),
		...(routeHint.route || routeHint.scale ? { routeHint } : {}),
	};
}

export function classifyRoutePolicy(userRequest: string, hint?: RouteHint): RoutePolicy {
	const normalized = normalizeRouteHint(hint);
	const lower = userRequest.toLowerCase();
	const explicit = normalized.route !== undefined || normalized.scale !== undefined;
	const autoRoute = inferRoute(lower);
	const route = normalized.route ?? autoRoute.route;
	const scale = normalized.scale ?? inferScale(route, lower);

	return buildRoutePolicy({
		route,
		scale,
		source: explicit ? "explicit" : "auto",
		confidence: explicit ? "high" : autoRoute.confidence,
		reasons: explicit ? ["explicit route/fanout hint"] : autoRoute.reasons,
	});
}

export function renderRoutePolicyForPlanner(policy: RoutePolicy): string {
	const caps = Object.entries(policy.taskCaps)
		.map(([persona, cap]) => `- ${persona}: ${cap.min}-${cap.max}`)
		.join("\n");
	return [
		"# Route Policy",
		`route: ${policy.route}`,
		`scale: ${policy.scale}`,
		`source: ${policy.source}`,
		`confidence: ${policy.confidence}`,
		"reasons:",
		...policy.reasons.map((reason) => `- ${reason}`),
		"",
		"task caps:",
		caps || "- (none)",
		"",
		"audit_review rules:",
		"- repo_scout is a context probe, not a global single-point gate.",
		"- Prefer scoped repo_scout tasks by module, file cluster, or finding domain.",
		"- One reviewer owns exactly one finding domain or one bounded file cluster.",
		"- docs depends on completed reviewer reports, not repo_scout.file_list.",
	].join("\n");
}

function inferRoute(lower: string): Pick<RoutePolicy, "route" | "confidence" | "reasons"> {
	if (/(dead code|conflict|audit|review|security|quality|report|冗余|冲突|审计|评审|报告|坏味道)/i.test(lower)) {
		return { route: "audit_review", confidence: "high", reasons: ["review/audit keyword"] };
	}
	if (/(error|failed|failing|crash|regression|stack trace|报错|失败|回归|崩溃)/i.test(lower)) {
		return { route: "debug_fix", confidence: "high", reasons: ["failure/debug keyword"] };
	}
	if (/(package\.json|lockfile|tsconfig|build config|lint|ci|dependency|toolchain|依赖|构建|配置)/i.test(lower)) {
		return { route: "dependency_config", confidence: "high", reasons: ["dependency/config keyword"] };
	}
	if (/(explain|analyze|describe|what is|how does|查看|分析|解释|怎么工作|理解)/i.test(lower) && !/(fix|patch|修改|实现)/i.test(lower)) {
		return { route: "scan_only", confidence: "medium", reasons: ["read-only exploration keyword"] };
	}
	if (/(small patch|typo|narrow|specific file|小修|局部)/i.test(lower)) {
		return { route: "direct_edit", confidence: "medium", reasons: ["small edit keyword"] };
	}
	if (/(implement|feature|refactor|support|add|修改行为|实现|功能|重构|接入)/i.test(lower)) {
		return { route: "implementation", confidence: "medium", reasons: ["implementation keyword"] };
	}
	return { route: "full_pipeline", confidence: "low", reasons: ["fallback: mixed or unclear request"] };
}

function inferScale(route: OrchestrationRoute, lower: string): FanoutScale {
	if (route === "full_pipeline") return "auto";
	if (route === "scan_only" || route === "direct_edit") return "small";
	if (/(repo-wide|whole repo|across the repo|cross-module|many modules|migration|全仓|跨模块|大范围)/i.test(lower)) return "large";
	if (route === "dependency_config") return "small";
	return "medium";
}

function buildRoutePolicy(input: Pick<RoutePolicy, "route" | "scale" | "source" | "confidence" | "reasons">): RoutePolicy {
	return {
		...input,
		taskCaps: taskCapsFor(input.route, input.scale),
		personaCaps: personaCapsFor(input.route, input.scale),
		granularityCaps: granularityCapsFor(input.scale),
		executionDepthByPersona: executionDepthFor(input.route, input.scale),
	};
}

function taskCapsFor(route: OrchestrationRoute, scale: FanoutScale): RoutePolicy["taskCaps"] {
	if (route === "audit_review") {
		if (scale === "large") return { repo_scout: { min: 2, max: 4 }, reviewer: { min: 6, max: 10 }, docs: { min: 1, max: 1 } };
		if (scale === "medium") return { repo_scout: { min: 1, max: 2 }, reviewer: { min: 3, max: 5 }, docs: { min: 1, max: 1 } };
		return { repo_scout: { min: 1, max: 1 }, reviewer: { min: 2, max: 2 }, docs: { min: 1, max: 1 } };
	}
	if (route === "implementation") {
		if (scale === "large") return { repo_scout: { min: 2, max: 4 }, test_writer: { min: 3, max: 6 }, code_executor: { min: 3, max: 6 }, test_runner: { min: 2, max: 4 }, reviewer: { min: 1, max: 2 }, docs: { min: 1, max: 1 } };
		if (scale === "medium") return { repo_scout: { min: 1, max: 2 }, test_writer: { min: 2, max: 3 }, code_executor: { min: 2, max: 3 }, test_runner: { min: 2, max: 2 }, reviewer: { min: 1, max: 1 } };
		return { repo_scout: { min: 1, max: 1 }, test_writer: { min: 1, max: 1 }, code_executor: { min: 1, max: 1 }, test_runner: { min: 1, max: 2 } };
	}
	if (route === "debug_fix") {
		if (scale === "large") return { runtime_debug: { min: 1, max: 2 }, code_executor: { min: 2, max: 3 }, test_runner: { min: 2, max: 3 }, reviewer: { min: 1, max: 2 } };
		if (scale === "medium") return { runtime_debug: { min: 1, max: 1 }, code_executor: { min: 1, max: 2 }, test_runner: { min: 1, max: 2 }, reviewer: { min: 1, max: 1 } };
		return { runtime_debug: { min: 1, max: 1 }, code_executor: { min: 1, max: 1 }, test_runner: { min: 1, max: 1 } };
	}
	if (route === "dependency_config") {
		if (scale === "large") return { repo_scout: { min: 1, max: 2 }, code_executor: { min: 2, max: 3 }, test_runner: { min: 2, max: 3 }, reviewer: { min: 1, max: 1 } };
		if (scale === "medium") return { repo_scout: { min: 1, max: 1 }, code_executor: { min: 1, max: 2 }, test_runner: { min: 1, max: 2 } };
		return { repo_scout: { min: 1, max: 1 }, code_executor: { min: 1, max: 1 }, test_runner: { min: 1, max: 1 } };
	}
	if (route === "direct_edit") return { repo_scout: { min: 1, max: 1 }, code_executor: { min: 1, max: 1 }, test_runner: { min: 0, max: 1 } };
	if (route === "scan_only") return { repo_scout: { min: 1, max: 1 } };
	return {};
}

function personaCapsFor(route: OrchestrationRoute, scale: FanoutScale): RoutePolicy["personaCaps"] {
	const reviewer = scale === "large" ? 3 : scale === "medium" ? 2 : 1;
	return {
		repo_scout: scale === "large" ? 4 : 2,
		reviewer,
		code_executor: route === "dependency_config" ? 1 : scale === "large" ? 3 : 2,
		test_writer: scale === "large" ? 3 : 2,
		test_runner: scale === "large" ? 3 : 2,
		runtime_debug: 1,
		context_builder: 1,
		docs: 1,
		vision: 1,
		web_searcher: 2,
	};
}

function granularityCapsFor(scale: FanoutScale): RoutePolicy["granularityCaps"] {
	return {
		reviewerMaxDomains: 1,
		reviewerMaxCoreFiles: scale === "large" ? 8 : 5,
		executorMaxFiles: 5,
		testWriterMaxAcceptance: 3,
		contextPackMaxTokens: scale === "large" ? 6_000 : scale === "medium" ? 5_000 : 3_000,
	};
}

function executionDepthFor(route: OrchestrationRoute, scale: FanoutScale): RoutePolicy["executionDepthByPersona"] {
	return {
		repo_scout: "normal",
		reviewer: scale === "small" ? "fast" : "normal",
		code_executor: scale === "large" && route === "implementation" ? "deep" : "normal",
		test_writer: "normal",
		test_runner: "fast",
		runtime_debug: "deep",
		docs: scale === "large" ? "normal" : "fast",
	};
}
