import { CodeValidator } from "../validators/CodeValidator.js";
import { ContextManager } from "../context/ContextManager.js";
import { CompletenessChecker } from "../completeness/CompletenessChecker.js";
import { ToolCallRepair } from "../repair/ToolCallRepair.js";
import { IterationManager } from "../iteration/IterationManager.js";
import { MiMoLoop } from "../loop/MiMoLoop.js";
import { mergeConfig, type MiMoConfig } from "./MiMoConfig.js";

export interface MiMoStack {
	loop: MiMoLoop;
	validator: CodeValidator;
	contextManager: ContextManager;
}

/**
 * createMiMoStack — 从单一配置对象构建完整的 MiMo 运行栈。
 *
 * 之前各组件的构造参数（上下文阈值、容量阈值、风暴窗口等）散落在各自构造器里，
 * 这个工厂把它们统一从 MiMoConfig 中读取，消除魔法数字。
 *
 * 用法：
 *   const { loop } = createMiMoStack(client, tools, process.cwd(), config);
 *   for await (const event of loop.run(userInput)) { ... }
 */
export function createMiMoStack(
	client: any,
	tools: any,
	workingDirectory: string,
	userConfig: MiMoConfig = {},
): MiMoStack {
	const cfg = mergeConfig(userConfig);

	// Validator — 根据 validation 配置决定启用哪些 checker
	const enabledCheckers: string[] = [];
	if (cfg.validation.enabled) {
		if (cfg.validation.syntax) enabledCheckers.push("syntax");
		if (cfg.validation.tsc) enabledCheckers.push("type");
		if (cfg.validation.pattern) enabledCheckers.push("pattern");
	}
	const validator = new CodeValidator(
		enabledCheckers.length > 0 ? { enabledCheckers } : undefined,
	);

	// Context manager — 统一阈值
	const contextManager = new ContextManager({
		foldThreshold: cfg.context.foldThreshold,
		aggressiveThreshold: cfg.context.aggressiveThreshold,
		tailFraction: cfg.context.tailFraction,
	});

	const loop = new MiMoLoop({
		client,
		tools,
		validator: cfg.validation.enabled ? validator : undefined,
		contextManager,
		completenessChecker: cfg.completeness.enabled
			? new CompletenessChecker()
			: undefined,
		toolRepair: new ToolCallRepair(),
		iterationManager: new IterationManager(),
		capacity: cfg.capacity,
		storm: cfg.storm,
		enableReadGuard: cfg.enableReadGuard,
		maxTokens: cfg.maxTokens,
		maxSteps: cfg.maxSteps,
		budgetUsd: cfg.budgetUsd || undefined,
		workingDirectory,
	});

	return { loop, validator, contextManager };
}
