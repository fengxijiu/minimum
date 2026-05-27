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
}

export interface MiMoConfig {
	/** 最大 context 窗口 token 数（默认 131072） */
	maxTokens?: number;
	/** 单次任务最大步骤数（默认 50） */
	maxSteps?: number;
	/** API 成本预算上限，USD（默认不限） */
	budgetUsd?: number;
	/** 是否启用先读后写守卫（默认 true） */
	enableReadGuard?: boolean;
	/** plan mode：只读规划，禁止变异工具（默认 false） */
	planMode?: boolean;
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
}

/** 所有优化分析得来的默认值 */
export const DEFAULT_MIMO_CONFIG: Required<MiMoConfig> = {
	maxTokens: 131072,
	maxSteps: 50,
	budgetUsd: 0,
	enableReadGuard: true,
	planMode: false,
	context: {
		foldThreshold: 0.70,
		aggressiveThreshold: 0.75,
		tailFraction: 0.25,
	},
	capacity: {
		enabled: true,
		lowRiskMax: 0.50,
		mediumRiskMax: 0.62,
		severeMinSlack: -0.25,
		refreshCooldownTurns: 6,
	},
	storm: {
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
};

/** 深合并用户配置与默认配置 */
export function mergeConfig(user: MiMoConfig = {}): Required<MiMoConfig> {
	return {
		maxTokens: user.maxTokens ?? DEFAULT_MIMO_CONFIG.maxTokens,
		maxSteps: user.maxSteps ?? DEFAULT_MIMO_CONFIG.maxSteps,
		// 0 means no limit; undefined from user also means no limit
		budgetUsd: user.budgetUsd ?? DEFAULT_MIMO_CONFIG.budgetUsd,
		enableReadGuard: user.enableReadGuard ?? DEFAULT_MIMO_CONFIG.enableReadGuard,
		planMode: user.planMode ?? DEFAULT_MIMO_CONFIG.planMode,
		context: { ...DEFAULT_MIMO_CONFIG.context, ...user.context },
		capacity: { ...DEFAULT_MIMO_CONFIG.capacity, ...user.capacity },
		storm: { ...DEFAULT_MIMO_CONFIG.storm, ...user.storm },
		validation: { ...DEFAULT_MIMO_CONFIG.validation, ...user.validation },
		completeness: { ...DEFAULT_MIMO_CONFIG.completeness, ...user.completeness },
	};
}
