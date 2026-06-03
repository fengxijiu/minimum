import { ApprovalManager } from "../approval/ApprovalManager.js";
import { CompletenessChecker } from "../completeness/CompletenessChecker.js";
import { ContextManager } from "../context/ContextManager.js";
import { IterationManager } from "../iteration/IterationManager.js";
import { MiMoLoop } from "../loop/MiMoLoop.js";
import { SingleAgentMemoryManager } from "../memory/SingleAgentMemoryManager.js";
import type { IHookManager } from "../loop/MiMoLoop.js";
import { ToolCallRepair } from "../repair/ToolCallRepair.js";
import { SessionManager } from "../session/SessionManager.js";
import { ApplyPatchTool } from "../tools/filesystem/ApplyPatchTool.js";
import { ToolRateLimiter } from "../tools/limits/ToolRateLimiter.js";
import { TodoWriteTool } from "../tools/todo/TodoWriteTool.js";
import { ChoiceTool } from "../tools/choice/ChoiceTool.js";
import type { ConfirmationGate } from "../tools/choice/ConfirmationGate.js";
import { ExecShellTool } from "../tools/shell/ExecShellTool.js";
import { JobRegistry } from "../tools/shell/JobRegistry.js";
import { RunBackgroundTool } from "../tools/shell/RunBackgroundTool.js";
import { JobOutputTool } from "../tools/shell/JobOutputTool.js";
import { WaitForJobTool } from "../tools/shell/WaitForJobTool.js";
import { StopJobTool } from "../tools/shell/StopJobTool.js";
import { ListJobsTool } from "../tools/shell/ListJobsTool.js";
import { CodeQueryTool } from "../tools/code-query/CodeQueryTool.js";
import { SymbolsTool } from "../tools/code-query/SymbolsTool.js";
import { CodeValidator } from "../validators/CodeValidator.js";
import { type MiMoConfig, mergeConfig } from "./MiMoConfig.js";

export interface MiMoStack {
	loop: MiMoLoop;
	validator: CodeValidator;
	contextManager: ContextManager;
	sessionManager: SessionManager;
	approvalManager: ApprovalManager;
	memoryManager?: SingleAgentMemoryManager;
	rateLimiter?: ToolRateLimiter;
	jobs: JobRegistry;
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
	deps: { hookManager?: IHookManager; approvalManager?: ApprovalManager; toolRateLimiter?: ToolRateLimiter; confirmationGate?: ConfirmationGate } = {},
): MiMoStack {
	const cfg = mergeConfig(userConfig);

	// ToolRateLimiter — caller injection wins; otherwise build from config.
	const rateLimiter: ToolRateLimiter | undefined =
		deps.toolRateLimiter !== undefined
			? deps.toolRateLimiter
			: cfg.rateLimit === false
				? undefined
				: new ToolRateLimiter(cfg.rateLimit);

	// Wire rateLimiter into the registry if it supports setRateLimiter.
	if (typeof (tools as { setRateLimiter?: (l: typeof rateLimiter) => void }).setRateLimiter === "function") {
		(tools as { setRateLimiter: (l: typeof rateLimiter) => void }).setRateLimiter(rateLimiter);
	}

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

	// ApprovalManager — built from config unless the caller injects one.
	// Constructed before builtins because shell tools need it for non-allowlisted command gating.
	const approvalManager: ApprovalManager =
		deps.approvalManager instanceof ApprovalManager
			? deps.approvalManager
			: new ApprovalManager({ mode: cfg.approvalMode });

	// Shared JobRegistry across all background-job tools in this stack.
	const jobs = new JobRegistry();

	// Register built-in tools when the registry supports it.
	const shellOpts = {
		rootDir: workingDirectory,
		timeoutSec: cfg.shell.timeoutSec,
		maxOutputChars: cfg.shell.maxOutputChars,
		extraAllowed: cfg.shell.extraAllowed,
		approvalManager,
	};
	const builtins = [
		new TodoWriteTool(),
		new ApplyPatchTool(),
		new ChoiceTool({ gate: deps.confirmationGate }),
		new ExecShellTool(shellOpts),
		new RunBackgroundTool({ jobs, ...shellOpts }),
		new JobOutputTool({ jobs }),
		new WaitForJobTool({ jobs }),
		new StopJobTool({ jobs }),
		new ListJobsTool({ jobs }),
		new SymbolsTool(),
		new CodeQueryTool(),
	] as const;
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

	// SessionManager — automatic session persistence; one instance per stack.
	const sessionManager = new SessionManager();

	const memoryManager = cfg.memory.enabled
		? new SingleAgentMemoryManager({
			workingDirectory,
			config: cfg.memory,
		})
		: undefined;

	const iterationManager = cfg.completeness.enabled
		? new IterationManager({ maxRetries: 3, learnFromErrors: true })
		: undefined;

	const loop = new MiMoLoop({
		client,
		tools,
		validator: cfg.validation.enabled ? validator : undefined,
		contextManager,
		completenessChecker: cfg.completeness.enabled
			? new CompletenessChecker()
			: undefined,
		completenessMinScore: cfg.completeness.minScore,
		completenessMaxFeedbackPerFile: cfg.completeness.maxFeedbackPerFile,
		iterationManager,
		iterationMaxRetries: 3,
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
		// Wire model + billingMode through to the loop so its pricing module
		// reads the right table. MiMoClient exposes getters; fall back to
		// config defaults if the caller passed a custom client without them.
		model: typeof client?.getModel === "function" ? client.getModel() : cfg.defaultModel,
		billingMode: typeof client?.getBillingMode === "function" ? client.getBillingMode() : "api",
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
		rateLimiter,
		jobs,
	};
}
