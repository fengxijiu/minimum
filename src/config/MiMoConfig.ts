import type { ToolRateLimitOption } from "../tools/limits/ToolRateLimiter.js";
import type { McpServerConfig } from "../mcp/types.js";

/**
 * MiMoConfig — 统一配置类型。
 *
 * 把原本散落在 MiMoLoop 构造器、ContextManager 构造器、CapacityController 构造器、
 * StormBreaker 构造器里的魔法数字集中到一处，并附上从优化分析得来的默认值。
 *
 * 参考来源：
 *   foldThreshold / aggressiveThreshold — CODING_OPTIMIZATION 更保守值（0.70/0.75）
 *   capacity 阈值 — CodeWhale CapacityController 默认值
 *   storm 窗口 — DeepSeek-Reasonix StormBreaker 默认值
 */

export interface ContextConfig {
	/** 开始折叠上下文的 token 占比阈值（默认 0.70） */
	foldThreshold?: number;
	/** 激进折叠阈值（默认 0.75） */
	aggressiveThreshold?: number;
	/** 折叠后保留尾部消息的比例（默认 0.25） */
	tailFraction?: number;
}

export interface CapacityGuardConfig {
	/** 是否启用容量检查点（默认 true） */
	enabled?: boolean;
	/** low 风险上限比（默认 0.50） */
	lowRiskMax?: number;
	/** medium 风险上限比（默认 0.62） */
	mediumRiskMax?: number;
	/** 触发 verify_and_replan 的最小 slack 值（默认 -0.25） */
	severeMinSlack?: number;
	/** targeted_refresh 冷却轮次（默认 6） */
	refreshCooldownTurns?: number;
}

export interface StormConfig {
	/** 是否启用风暴检测（默认 false — 已关闭重复调用守卫） */
	enabled?: boolean;
	/** 风暴检测窗口大小（默认 6） */
	windowSize?: number;
	/** 触发抑制的重复阈值（默认 3） */
	threshold?: number;
}

export interface ValidationConfig {
	/** 是否启用验证（默认 true） */
	enabled?: boolean;
	/** 启用语法检查（默认 true） */
	syntax?: boolean;
	/** 启用 tsc 诊断回灌（默认 true） */
	tsc?: boolean;
	/** 启用 pattern 检查（默认 true） */
	pattern?: boolean;
}

export interface CompletenessConfig {
	/** 是否启用完整性检查（默认 true） */
	enabled?: boolean;
	/** 低于此分时将缺口反馈给模型（0–100，默认 0 = 仅 complete:false 时才注入） */
	minScore?: number;
	/** 同一文件连续触发几次后停止注入，防刷屏（默认 2） */
	maxFeedbackPerFile?: number;
}

export interface MemoryConfig {
	/** 是否启用单代理长期记忆（默认 true） */
	enabled?: boolean;
	/** 全局记忆存储路径（默认 ~/.minimum/memory） */
	globalBasePath?: string;
	/** 每轮最多注入的相关记忆条数（默认 8） */
	maxPreludeEntries?: number;
	/** 每个作用域保留的最大记忆条数（默认 200） */
	maxStoredEntries?: number;
	/** 记忆注入配置 */
	injection?: {
		/** 每次注入到上下文的最大 token 数（默认 2500） */
		maxTokens?: number;
	};
	/** 记忆写回配置 */
	writeback?: {
		/** 自动合并项目级记忆（默认 true） */
		autoMergeProject?: boolean;
		/** 自动合并全局记忆（默认 false） */
		autoMergeGlobal?: boolean;
	};
	/** 记忆压缩配置 */
	compaction?: {
		/** 是否启用记忆压缩（默认 true） */
		enabled?: boolean;
	};
}

export interface MiMoConfig {
	/** MiMo API key（来自 `init` 注册的全局配置，env MIMO_API_KEY 优先） */
	apiKey?: string;
	/** MiMo API base URL（默认 https://api.xiaomimimo.com/v1） */
	baseUrl?: string;
	/** 默认模型名（默认 mimo-v2.5-pro） */
	defaultModel?: string;
	/** 最大 context 窗口 token 数（默认 131072） */
	maxTokens?: number;
	/** 单次任务最大步骤数（默认 200） */
	maxSteps?: number;
	/** API 成本预算上限，USD（默认不限） */
	budgetUsd?: number;
	/** 是否启用先读后写守卫（默认 true） */
	enableReadGuard?: boolean;
	/** plan mode：只读规划，禁止变异工具（默认 false） */
	planMode?: boolean;
	/** 单步工具调用超时阈值（毫秒）。超时后弹出 ask_choice 询问用户是否继续/关闭。0 禁用（默认 0）。 */
	toolTimeoutMs?: number;
	/**
	 * 三档审批模式（对标 Codex）:
	 *   read-only  — 仅读工具，写操作全拦
	 *   auto-edit  — 文件改写自动放行，shell 需确认
	 *   full-auto  — 全自动（沙箱内使用）
	 *   suggest    — 低风险自动放行，其余弹确认（默认）
	 *   never      — 全拦
	 */
	approvalMode?: "read-only" | "auto-edit" | "full-auto" | "suggest" | "never";
	/** 上下文管理阈值 */
	context?: ContextConfig;
	/** 容量检查点配置 */
	capacity?: CapacityGuardConfig;
	/** 工具调用风暴检测配置 */
	storm?: StormConfig;
	/** 代码验证配置 */
	validation?: ValidationConfig;
	/** 完整性检查配置 */
	completeness?: CompletenessConfig;
	/** 单代理长期记忆配置 */
	memory?: MemoryConfig;
	/** 工具调用限流配置(false 关闭,缺省使用 ToolRateLimiter 的内置默认)*/
	rateLimit?: ToolRateLimitOption;
	/** Shell 工具配置(exec_shell + run_background 等的默认值)*/
	shell?: {
		timeoutSec?: number;
		maxOutputChars?: number;
		extraAllowed?: readonly string[];
	};
	/** MCP (Model Context Protocol) 外部工具服务器列表(默认空)。
	 *  每个 server 启动后,其工具以 `mcp__<server>__<tool>` 名称注册进工具表。*/
	mcpServers?: McpServerConfig[];
	/** master_planner 按任务额外授予的能力(skills + MCP)。 */
	capabilityGrants?: {
		/** 总开关;false 时不向 master 提供也不兑现任何授权。默认 true。 */
		enabled?: boolean;
		/** 永不可授予的 skill id。 */
		denylistSkills?: string[];
		/** 永不可授予的 MCP 工具名(mcp__server__tool)。 */
		denylistMcpTools?: string[];
	};
}

/** 所有优化分析得来的默认值 */
export const DEFAULT_MIMO_CONFIG: Required<MiMoConfig> = {
	apiKey: "",
	baseUrl: "https://api.xiaomimimo.com/v1",
	defaultModel: "mimo-v2.5-pro",
	maxTokens: 131072,
	maxSteps: 200,
	budgetUsd: 0,
	enableReadGuard: true,
	planMode: false,
	toolTimeoutMs: 0,
	approvalMode: "suggest",
	context: {
		foldThreshold: 0.7,
		aggressiveThreshold: 0.75,
		tailFraction: 0.25,
	},
	capacity: {
		enabled: true,
		lowRiskMax: 0.5,
		mediumRiskMax: 0.62,
		severeMinSlack: -0.25,
		refreshCooldownTurns: 6,
	},
	storm: {
		enabled: false,
		windowSize: 6,
		threshold: 3,
	},
	validation: {
		enabled: true,
		syntax: true,
		tsc: true,
		pattern: true,
	},
	completeness: {
		enabled: true,
	},
	memory: {
		enabled: true,
		globalBasePath: "",
		maxPreludeEntries: 8,
		maxStoredEntries: 200,
		injection: {
			maxTokens: 2500,
		},
		writeback: {
			autoMergeProject: true,
			autoMergeGlobal: false,
		},
		compaction: {
			enabled: true,
		},
	},
	rateLimit: {},
	shell: {
		timeoutSec: 60,
		maxOutputChars: 32_000,
		extraAllowed: [],
	},
	mcpServers: [],
	capabilityGrants: {
		enabled: true,
		denylistSkills: [],
		denylistMcpTools: [],
	},
};

/** 深合并用户配置与默认配置 */
export function mergeConfig(user: MiMoConfig = {}): Required<MiMoConfig> {
	return {
		apiKey: user.apiKey ?? DEFAULT_MIMO_CONFIG.apiKey,
		baseUrl: user.baseUrl ?? DEFAULT_MIMO_CONFIG.baseUrl,
		defaultModel: user.defaultModel ?? DEFAULT_MIMO_CONFIG.defaultModel,
		maxTokens: user.maxTokens ?? DEFAULT_MIMO_CONFIG.maxTokens,
		maxSteps: user.maxSteps ?? DEFAULT_MIMO_CONFIG.maxSteps,
		// 0 means no limit; undefined from user also means no limit
		budgetUsd: user.budgetUsd ?? DEFAULT_MIMO_CONFIG.budgetUsd,
		enableReadGuard:
			user.enableReadGuard ?? DEFAULT_MIMO_CONFIG.enableReadGuard,
		planMode: user.planMode ?? DEFAULT_MIMO_CONFIG.planMode,
		toolTimeoutMs: user.toolTimeoutMs ?? DEFAULT_MIMO_CONFIG.toolTimeoutMs,
		approvalMode: user.approvalMode ?? DEFAULT_MIMO_CONFIG.approvalMode,
		context: { ...DEFAULT_MIMO_CONFIG.context, ...user.context },
		capacity: { ...DEFAULT_MIMO_CONFIG.capacity, ...user.capacity },
		storm: { ...DEFAULT_MIMO_CONFIG.storm, ...user.storm },
		validation: { ...DEFAULT_MIMO_CONFIG.validation, ...user.validation },
		completeness: { ...DEFAULT_MIMO_CONFIG.completeness, ...user.completeness },
		memory: {
			...DEFAULT_MIMO_CONFIG.memory,
			...user.memory,
			injection: {
				...DEFAULT_MIMO_CONFIG.memory.injection,
				...user.memory?.injection,
			},
			writeback: {
				...DEFAULT_MIMO_CONFIG.memory.writeback,
				...user.memory?.writeback,
			},
			compaction: {
				...DEFAULT_MIMO_CONFIG.memory.compaction,
				...user.memory?.compaction,
			},
		},
		rateLimit:
			user.rateLimit === false
				? false
				: user.rateLimit === undefined
					? DEFAULT_MIMO_CONFIG.rateLimit
					: typeof user.rateLimit === "object" && typeof DEFAULT_MIMO_CONFIG.rateLimit === "object"
						? { ...DEFAULT_MIMO_CONFIG.rateLimit, ...user.rateLimit }
						: user.rateLimit,
		shell: { ...DEFAULT_MIMO_CONFIG.shell, ...user.shell },
		mcpServers: user.mcpServers ?? DEFAULT_MIMO_CONFIG.mcpServers,
		capabilityGrants: { ...DEFAULT_MIMO_CONFIG.capabilityGrants, ...user.capabilityGrants },
	};
}
