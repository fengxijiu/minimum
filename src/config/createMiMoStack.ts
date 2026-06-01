import { ApprovalManager } from "../approval/ApprovalManager.js";
import { CompletenessChecker } from "../completeness/CompletenessChecker.js";
import { ContextManager } from "../context/ContextManager.js";
import { MiMoLoop } from "../loop/MiMoLoop.js";
import { SingleAgentMemoryManager } from "../memory/single/SingleAgentMemoryManager.js";
import type { IHookManager } from "../loop/MiMoLoop.js";
import { ToolCallRepair } from "../repair/ToolCallRepair.js";
import { SessionManager } from "../session/SessionManager.js";
import { ApplyPatchTool } from "../tools/filesystem/ApplyPatchTool.js";
import { TodoWriteTool } from "../tools/todo/TodoWriteTool.js";
import { CodeValidator } from "../validators/CodeValidator.js";
import { type MiMoConfig, mergeConfig } from "./MiMoConfig.js";

export interface MiMoStack {
	loop: MiMoLoop;
	validator: CodeValidator;
	contextManager: ContextManager;
	sessionManager: SessionManager;
	approvalManager: ApprovalManager;
	memoryManager?: SingleAgentMemoryManager;
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
	deps: { hookManager?: IHookManager; approvalManager?: ApprovalManager } = {},
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

	// Register built-in tools when the registry supports it.
	const builtins = [new TodoWriteTool(), new ApplyPatchTool()] as const;
	if (typeof tools.register === "function") {
		for (const tool of builtins) {
			if (tools.has?.(tool.name)) continue;
			const def = tool.getDefinition();
			tools.register({
				name: tool.name,
				description: def.description,
				parameters: def.parameters,
				getDefinition: () => def,
				execute: (args: any, ctx?: any) => tool.execute(args, ctx),
				fn: (args: any, ctx?: any) => tool.execute(args, ctx),
			});
		}
	}

	// ApprovalManager — built from config unless the caller injects one.
	const approvalManager: ApprovalManager =
		deps.approvalManager instanceof ApprovalManager
			? deps.approvalManager
			: new ApprovalManager({ mode: cfg.approvalMode });

	// SessionManager — automatic session persistence; one instance per stack.
	const sessionManager = new SessionManager();

	const memoryManager = cfg.memory.enabled
		? new SingleAgentMemoryManager({
			projectRoot: workingDirectory,
			globalBasePath: cfg.memory.globalBasePath || undefined,
			maxPreludeEntries: cfg.memory.maxPreludeEntries,
			maxStoredEntries: cfg.memory.maxStoredEntries,
		})
		: undefined;

	const loop = new MiMoLoop({
		client,
		tools,
		validator: cfg.validation.enabled ? validator : undefined,
		contextManager,
		completenessChecker: cfg.completeness.enabled
			? new CompletenessChecker()
			: undefined,
		toolRepair: new ToolCallRepair(),
		capacity: cfg.capacity,
		storm: cfg.storm,
		enableReadGuard: cfg.enableReadGuard,
		planMode: cfg.planMode,
		hookManager: deps.hookManager,
		approvalManager,
		maxTokens: cfg.maxTokens,
		maxSteps: cfg.maxSteps,
		budgetUsd: cfg.budgetUsd || undefined,
		workingDirectory,
		sessionPersister: sessionManager,
		memoryManager,
	});

	return {
		loop,
		validator,
		contextManager,
		sessionManager,
		approvalManager,
		memoryManager,
	};
}
