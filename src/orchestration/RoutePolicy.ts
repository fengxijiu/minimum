import type { PersonaId } from "../personas/Persona.js";
import { listPersonas } from "../personas/PersonaRegistry.js";
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
		// CHANGED: only consume the next token as a hint value when it is not another flag.
		if (token === "--route" && isHintValueToken(tokens[i + 1])) {
			routeHint.route = tokens[++i];
			continue;
		}
		// CHANGED: drop malformed `--route` flags instead of leaking them into the user request.
		if (token === "--route") continue;
		// CHANGED: ignore malformed `--scale --route ...` / `--fanout --route ...` sequences.
		if ((token === "--fanout" || token === "--scale") && isHintValueToken(tokens[i + 1])) {
			routeHint.scale = tokens[++i];
			continue;
		}
		// CHANGED: drop malformed scale flags instead of keeping them in `cleanInput`.
		if (token === "--fanout" || token === "--scale") continue;
		kept.push(token);
	}
	return {
		cleanInput: kept.join(" "),
		...(routeHint.route || routeHint.scale ? { routeHint } : {}),
	};
}

function isHintValueToken(token?: string): token is string {
	return typeof token === "string" && token.length > 0 && !token.startsWith("--");
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
		.filter((entry): entry is [string, CountCap] => entry[1] !== undefined)
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
	return assignCapsByChainRole(route, scale, taskCapProfile(route, scale));
}

function personaCapsFor(route: OrchestrationRoute, scale: FanoutScale): RoutePolicy["personaCaps"] {
	const out: RoutePolicy["personaCaps"] = {};
	for (const persona of listPersonas()) {
		if (persona.kind !== "worker") continue;
		if (!persona.orchestration.routeRoles.includes(route)) continue;
		out[persona.id] = personaConcurrencyCap(persona.id, route, scale);
	}
	return out;
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
	const out: RoutePolicy["executionDepthByPersona"] = {};
	for (const persona of listPersonas()) {
		if (persona.kind !== "worker") continue;
		if (!persona.orchestration.routeRoles.includes(route)) continue;
		out[persona.id] = personaExecutionDepth(persona.id, route, scale);
	}
	return out;
}

type ChainRole =
	| "discover"
	| "design"
	| "scaffold"
	| "implement"
	| "test_author"
	| "validate"
	| "debug"
	| "review"
	| "document"
	| "deliver";

type TaskCapProfile = Partial<Record<ChainRole, CountCap>>;

function taskCapProfile(route: OrchestrationRoute, scale: FanoutScale): TaskCapProfile {
	if (route === "audit_review") {
		if (scale === "large") return { discover: { min: 2, max: 4 }, review: { min: 6, max: 10 }, document: { min: 1, max: 1 } };
		if (scale === "medium") return { discover: { min: 1, max: 2 }, review: { min: 3, max: 5 }, document: { min: 1, max: 1 } };
		return { discover: { min: 1, max: 1 }, review: { min: 2, max: 2 }, document: { min: 1, max: 1 } };
	}
	if (route === "implementation") {
		if (scale === "large") return { discover: { min: 2, max: 4 }, test_author: { min: 3, max: 6 }, implement: { min: 3, max: 6 }, validate: { min: 2, max: 4 }, review: { min: 1, max: 2 }, document: { min: 1, max: 1 } };
		if (scale === "medium") return { discover: { min: 1, max: 2 }, test_author: { min: 2, max: 3 }, implement: { min: 2, max: 3 }, validate: { min: 2, max: 2 }, review: { min: 1, max: 1 } };
		return { discover: { min: 1, max: 1 }, test_author: { min: 1, max: 1 }, implement: { min: 1, max: 1 }, validate: { min: 1, max: 2 } };
	}
	if (route === "debug_fix") {
		if (scale === "large") return { debug: { min: 1, max: 2 }, implement: { min: 2, max: 3 }, validate: { min: 2, max: 3 }, review: { min: 1, max: 2 } };
		if (scale === "medium") return { debug: { min: 1, max: 1 }, implement: { min: 1, max: 2 }, validate: { min: 1, max: 2 }, review: { min: 1, max: 1 } };
		return { debug: { min: 1, max: 1 }, implement: { min: 1, max: 1 }, validate: { min: 1, max: 1 } };
	}
	if (route === "dependency_config") {
		if (scale === "large") return { discover: { min: 1, max: 2 }, implement: { min: 2, max: 3 }, validate: { min: 2, max: 3 }, review: { min: 1, max: 1 } };
		if (scale === "medium") return { discover: { min: 1, max: 1 }, implement: { min: 1, max: 2 }, validate: { min: 1, max: 2 } };
		return { discover: { min: 1, max: 1 }, implement: { min: 1, max: 1 }, validate: { min: 1, max: 1 } };
	}
	if (route === "direct_edit") return { discover: { min: 1, max: 1 }, implement: { min: 1, max: 1 }, validate: { min: 0, max: 1 } };
	if (route === "scan_only") return { discover: { min: 1, max: 1 } };
	return {};
}

function assignCapsByChainRole(route: OrchestrationRoute, _scale: FanoutScale, profile: TaskCapProfile): RoutePolicy["taskCaps"] {
	const out: RoutePolicy["taskCaps"] = {};
	for (const persona of listPersonas()) {
		if (persona.kind !== "worker") continue;
		if (!persona.orchestration.routeRoles.includes(route)) continue;
		const cap = profile[persona.orchestration.chainRole as ChainRole];
		if (cap) out[persona.id] = cap;
	}
	return out;
}

function personaConcurrencyCap(personaId: PersonaId, route: OrchestrationRoute, scale: FanoutScale): number {
	const persona = listPersonas().find((p) => p.id === personaId);
	if (!persona) return 2;
	const role = persona.orchestration.chainRole;
	if (role === "discover") return scale === "large" ? 4 : 2;
	if (role === "review") return scale === "large" ? 3 : scale === "medium" ? 2 : 1;
	if (role === "implement") return route === "dependency_config" ? 1 : scale === "large" ? 3 : 2;
	if (role === "test_author" || role === "validate") return scale === "large" ? 3 : 2;
	if (role === "debug" || role === "design" || role === "document" || role === "deliver") return 1;
	return persona.parallelism.maxConcurrent;
}

function personaExecutionDepth(personaId: PersonaId, route: OrchestrationRoute, scale: FanoutScale): ExecutionDepth {
	const persona = listPersonas().find((p) => p.id === personaId);
	if (!persona) return "normal";
	const role = persona.orchestration.chainRole;
	if (role === "review") return scale === "small" ? "fast" : "normal";
	if (role === "implement") return scale === "large" && route === "implementation" ? "deep" : "normal";
	if (role === "debug") return "deep";
	if (role === "document") return scale === "large" ? "normal" : "fast";
	return persona.orchestration.executionDepth;
}
